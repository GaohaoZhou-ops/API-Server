#!/usr/bin/env python3
"""Private admin IPC. Credentials travel through pipes, never argv or diagnostics."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sys
import yaml

from permissions import fields, load_policy, name, validate_policy, versions
from runtime import (ROOT, STATE, GROUP_HEADERS, atomic_text, config_location, config_lock,
                     directory_config, lock_file, read_unlocked, recover_split)

CONTENT = Path(os.environ.get('API_DOCS_CONTENT_ROOT', str(ROOT / 'var/content')))
PERMISSIONS_HEADER = '# 私有公司 / 部门权限；由管理员面板或服务器维护，不提交 Git。\n'
SCOPES = ('api_versions',)


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def reject(status, message):
    raise RequestError(status, message)


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def document_catalog():
    value = json.loads((CONTENT / 'versions.json').read_text())
    items = value['versions']
    if not items or len({item['id'] for item in items}) != len(items) or any(
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,63}', item['id']) for item in items
    ) or value['current'] not in {item['id'] for item in items}:
        raise ValueError('Invalid document catalog')
    return value


def recover_documents():
    """Finish an interrupted deletion. The catalog is the online visibility boundary."""
    journal = CONTENT / '.admin-delete.json'
    if not journal.exists():
        return
    entry = json.loads(journal.read_text())
    identifier, archive = entry['version'], entry['archive']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,63}', identifier) or not re.fullmatch(r'[a-f0-9]{32}', archive):
        raise ValueError('Invalid deletion journal')
    destination = CONTENT / '.deleted' / archive
    # Keep the full registry as well as the private snapshot for server-side recovery.
    saved = json.loads((destination / 'record.json').read_text())
    catalog = document_catalog()
    if any(item['id'] == identifier for item in catalog['versions']):
        if catalog != saved['before']:
            raise ValueError('Document registry changed during recovery')
        atomic_text(CONTENT / 'versions.json', json.dumps(saved['after'], ensure_ascii=False, indent=2) + '\n')
    source = CONTENT / 'versions' / identifier
    if source.is_symlink() or destination.is_symlink() or (CONTENT / '.deleted').is_symlink():
        raise ValueError('Unsafe document directory')
    if source.exists():
        os.replace(source, destination / 'snapshot')
    if not (destination / 'snapshot').is_dir():
        raise ValueError('Missing document snapshot')
    saved['completed_at'] = now()
    atomic_text(destination / 'record.json', json.dumps(saved, ensure_ascii=False, indent=2) + '\n')
    journal.unlink()


def delete_document(data, catalog):
    fields(data, ('revision', 'version', 'replacement', 'confirm'))
    identifier = data.get('version')
    if not isinstance(identifier, str) or data.get('confirm') != identifier:
        reject(400, '请输入完整文档版本号以确认删除。')
    if identifier not in {item['id'] for item in catalog['versions']}:
        reject(404, '文档版本不存在。')
    if len(catalog['versions']) <= 1:
        reject(409, '至少需要保留一个在线文档版本。')
    next_catalog = deepcopy(catalog)
    next_catalog['versions'] = [item for item in catalog['versions'] if item['id'] != identifier]
    if identifier == catalog['current']:
        replacement = data.get('replacement')
        if replacement not in {item['id'] for item in next_catalog['versions']}:
            reject(400, '删除默认文档前，请选择另一个默认版本。')
        next_catalog['current'] = replacement
    source = CONTENT / 'versions' / identifier
    archive_root = CONTENT / '.deleted'
    if source.is_symlink() or not source.is_dir() or (CONTENT / 'versions').is_symlink() or archive_root.is_symlink():
        reject(409, '文档目录异常，请在服务器检查。')
    archive_root.mkdir(mode=0o700, exist_ok=True)
    archive_root.chmod(0o700)
    archive = secrets.token_hex(16)
    destination = archive_root / archive
    destination.mkdir(mode=0o700)
    record = {'version': identifier, 'created_at': now(), 'before': catalog, 'after': next_catalog}
    atomic_text(destination / 'record.json', json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    # A durable intent precedes the catalog update and same-filesystem move.
    atomic_text(CONTENT / '.admin-delete.json', json.dumps({'version': identifier, 'archive': archive}))
    recover_documents()
    return {'version': identifier, 'current': next_catalog['current']}


def write_configuration(config, changes):
    """Use the same lock/journal as runtime updates; access and policy commit together."""
    previous = {key: (config / key).read_text() if (config / key).exists() else None for key in changes}
    atomic_text(config / '.pending.json', json.dumps(previous, ensure_ascii=False))
    try:
        for key, text in changes.items():
            atomic_text(config / key, text)
        (config / '.pending.json').unlink()
    except BaseException:
        recover_split(config)
        raise


def credentials(value):
    for company, item in value.get('companies', {}).items():
        for department, rule in item.get('departments', {}).items():
            yield company, department, rule


def audit(action, details):
    # No passwords, tokens, IPs, email settings or request bodies in this log.
    file = STATE / 'admin-audit.json'
    try:
        events = json.loads(file.read_text()) if file.exists() else []
        events.append({'time': now(), 'action': action, **details})
        atomic_text(file, json.dumps(events[-200:], ensure_ascii=False, indent=2) + '\n')
        return None
    except Exception:
        return '操作已完成，但操作记录写入失败，请检查服务器状态目录。'


def handle(action, message):
    config = config_location()
    if not directory_config(config):
        reject(503, '管理员面板需要 config/ 分组配置，请先在服务器迁移旧配置。')
    descriptor = lock_file(config_lock(config))
    try:
        full = read_unlocked(config)
        access = full['api_docs']['access']
        administrator = access.get('admin_password')
        if not administrator or administrator == access.get('password') or not hmac.compare_digest(
                hashlib.sha256(administrator.encode()).hexdigest(), message.get('admin_signature', '')):
            reject(401, '管理员凭据已变更，请重新登录。')
        policy = load_policy(config / 'permissions.yaml')
        validate_policy(policy, [access.get('password'), administrator])
        catalog = document_catalog()
        choices = {**message.get('resources', {}), 'api_versions': [item['id'] for item in catalog['versions']]}
        digest = json.dumps({'access': {key: access.get(key) for key in ('password', 'admin_password', 'password_updated_at')},
                             'policy': policy, 'documents': catalog, 'choices': choices}, sort_keys=True, ensure_ascii=False)
        revision = hmac.new(bytes.fromhex(message['revision_key']), digest.encode(), hashlib.sha256).hexdigest()
        if action == 'overview':
            departments = [{'company': company, 'department': department, 'enabled': rule.get('enabled', True),
                            'has_password': bool(rule.get('password')), **{key: rule.get(key, []) for key in SCOPES}}
                           for company, department, rule in credentials(policy)]
            file = STATE / 'admin-audit.json'
            events = json.loads(file.read_text())[-20:][::-1] if file.exists() else []
            return {'revision': revision, 'departments': departments, 'choices': choices,
                    'documents': {**catalog, 'versions': [{key: item.get(key) for key in ('id', 'label', 'published_at', 'date')}
                                                        for item in catalog['versions']]},
                    'password_updated_at': access.get('password_updated_at'), 'audit': events}
        data = message.get('data', {})
        if not hmac.compare_digest(str(data.get('revision', '')), revision):
            reject(409, '配置或版本已变更，请刷新面板后重试。')
        if action == 'view-request-password':
            fields(data, ('revision', 'id', 'request_token', 'expected_grant_id'))
            from access_grants import view_current
            from feedback import InputError
            try:
                return view_current(data, policy)
            except InputError as error:
                reject(error.status, error.message)
        if action in ('authorize-request', 'generate-request-password'):
            fields(data, ('revision', 'id', 'request_token', 'company', 'department', 'operation_id', 'expected_grant_id', 'draft_id'))
            from access_grants import authorize, generate
            from feedback import InputError
            try:
                result = (generate if action == 'generate-request-password' else authorize)(data, full['api_docs'], policy)
            except InputError as error:
                reject(error.status, error.message)
            warning = audit(action, {'company': data['company'], 'department': data['department']}) if result.get('queued', action == 'generate-request-password') else None
            return {'ok': True, **result, 'warning': warning}
        if action == 'clear-records':
            fields(data, ('revision', 'target', 'admin_password'))
            target = data.get('target')
            if target not in ('audit', 'visits', 'requests'):
                reject(400, '请选择要清理的记录类型。')
            password = data.get('admin_password')
            if not isinstance(password, str) or not password or len(password) > 1024:
                reject(400, '请输入管理员密码。')
            if not hmac.compare_digest(password.encode(), administrator.encode()):
                reject(400, '管理员密码错误，未清理记录。')
            # The current admin credential is checked again under the same lock as
            # the deletion. A shared/department password can never authorize it.
            if target == 'audit':
                file = STATE / 'admin-audit.json'
                events = json.loads(file.read_text()) if file.exists() else []
                if not isinstance(events, list):
                    raise ValueError('Invalid audit records')
                count = len(events)
                atomic_text(file, '[]\n')
                warning = None  # Leave this category empty after an explicit clear.
            else:
                if target == 'visits':
                    from visit_history import clear
                else:
                    from access_requests import clear
                count = clear()
                warning = audit(action, {'target': target, 'count': count})
            return {'ok': True, 'target': target, 'cleared': count, 'warning': warning}
        if action == 'view-passwords':
            fields(data, ('revision', 'target', 'company', 'department'))
            target = data.get('target')
            if target not in ('all', 'shared', 'department'):
                reject(400, '请选择用户密码范围。')
            if target == 'department':
                name(data.get('company')); name(data.get('department'))
            elif 'company' in data or 'department' in data:
                reject(400, '只有部门密码需要指定公司和部门。')
            passwords = []
            if target in ('all', 'shared'):
                passwords.append({'kind': 'shared', 'password': access.get('password', '')})
            for company, department, rule in credentials(policy):
                if target == 'all' or (target == 'department' and company == data['company'] and department == data['department']):
                    password = rule.get('password', '')
                    if not isinstance(password, str):
                        reject(400, '部门密码配置无效，请在服务器检查。')
                    passwords.append({'kind': 'department', 'company': company, 'department': department, 'password': password})
            if target == 'department' and not passwords:
                reject(404, '部门不存在。')
            # A deliberate read never writes configuration, audit entries or notification jobs.
            return {'passwords': passwords}
        generated, details, changes = [], {}, {}
        if action == 'save-department':
            fields(data, ('revision', 'original', 'company', 'department', 'enabled', *SCOPES))
            company, department = data.get('company'), data.get('department')
            name(company); name(department)
            if company != company.strip() or department != department.strip():
                reject(400, '公司和部门名称不能包含首尾空白。')
            original = data.get('original')
            old = None
            if original is not None:
                fields(original, ('company', 'department'))
                old = policy.get('companies', {}).get(original.get('company'), {}).get('departments', {}).get(original.get('department'))
                if old is None:
                    reject(404, '原部门不存在，请刷新面板。')
            company_rules = policy.setdefault('companies', {}).setdefault(company, {'departments': {}}).setdefault('departments', {})
            if department in company_rules and (not original or original != {'company': company, 'department': department}):
                reject(409, '该公司已存在同名部门。')
            rule = deepcopy(old) if old is not None else {}
            rule['enabled'] = data.get('enabled', True)
            if type(rule['enabled']) is not bool:
                reject(400, '启用状态必须为 true 或 false。')
            for key in SCOPES:
                rule[key] = versions(data.get(key, []))
                if set(rule[key]) - set(choices.get(key, [])) - set((old or {}).get(key, [])):
                    reject(400, '只能新增已发布版本的授权。')
            if old is None or (rule['enabled'] and not rule.get('password')):
                rule['password'] = secrets.token_urlsafe(24)
                generated.append({'company': company, 'department': department, 'password': rule['password']})
            if original and original != {'company': company, 'department': department}:
                previous = policy['companies'][original['company']]['departments']
                del previous[original['department']]
                if not previous and original['company'] != company:
                    del policy['companies'][original['company']]
            company_rules[department] = rule
            details = {'company': company, 'department': department, 'enabled': rule['enabled']}
        elif action == 'reset-passwords':
            fields(data, ('revision', 'target', 'company', 'department', 'confirm'))
            target = data.get('target')
            if target not in ('all', 'shared', 'department') or data.get('confirm') != '重置':
                reject(400, '请输入“重置”以确认密码重置。')
            if target in ('all', 'shared'):
                password = message.get('shared_password')
                if not isinstance(password, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32}', password) or password == administrator:
                    raise ValueError('Invalid generated credential')
                access['password'] = password
                access['password_updated_at'] = now()
                changes['access.yaml'] = GROUP_HEADERS['access'] + yaml.safe_dump(access, allow_unicode=True, sort_keys=False)
                generated.append({'kind': 'shared', 'password': password})
            matched = 0
            for company, department, rule in credentials(policy):
                if target == 'all' or (target == 'department' and company == data.get('company') and department == data.get('department')):
                    matched += 1
                    rule['password'] = secrets.token_urlsafe(24)
                    generated.append({'company': company, 'department': department, 'password': rule['password']})
            if target == 'department' and not matched:
                reject(404, '部门不存在。')
            details = {'target': target, 'count': len(generated)}
            if target == 'department':
                details.update(company=data['company'], department=data['department'])
        elif action == 'delete-document':
            result = delete_document(data, catalog)
            warning = audit(action, {'version': result['version']})
            return {'ok': True, **result, 'warning': warning}
        else:
            reject(404, '管理操作不存在。')
        validate_policy(policy, [access.get('password'), administrator])
        changes['permissions.yaml'] = PERMISSIONS_HEADER + yaml.safe_dump(policy, allow_unicode=True, sort_keys=False)
        if len(changes['permissions.yaml'].encode()) > 1024 * 1024:
            reject(400, '权限配置超过大小限制。')
        write_configuration(config, changes)
        warning = audit(action, details)
        return {'ok': True, 'generated': generated, 'password_updated_at': access.get('password_updated_at'), 'warning': warning}
    finally:
        os.close(descriptor)


def main():
    action = sys.argv[1]
    message = json.load(sys.stdin)
    descriptor = lock_file(STATE / 'admin-panel.lock')
    try:
        recover_documents()
        if action == 'recover':
            return {'ok': True}
        return handle(action, message)
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except RequestError as error:
        print(json.dumps({'status': error.status, 'error': str(error)}, ensure_ascii=False))
    except ValueError:
        print(json.dumps({'status': 400, 'error': '配置或输入无效；请检查字段、版本列表及密码是否重复。'}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'status': 503, 'error': '管理操作暂不可用，请检查服务器配置和目录权限。'}, ensure_ascii=False))
