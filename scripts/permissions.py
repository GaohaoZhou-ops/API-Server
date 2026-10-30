#!/usr/bin/env python3
"""Read the private department policy; never include credentials in diagnostics."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import yaml
from runtime import ROOT, config_file, read_config


class UniqueLoader(yaml.SafeLoader):
    pass


def mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str) or key in result:
            raise ValueError('配置键必须是唯一字符串')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def fields(value, allowed):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError('配置层级或字段名无效')


def name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 120 or re.search(r'[\x00-\x1f\x7f]', value):
        raise ValueError('公司或部门名称无效')


def versions(value):
    if not isinstance(value, list) or len(value) > 1000 or any(not isinstance(item, str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', item) for item in value):
        raise ValueError('版本必须是明确的字符串列表；不支持通配符')
    return sorted(set(value))


def load_policy(file):
    try:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {'companies': {}}
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
            raise ValueError('权限配置必须是小于 1 MiB 的普通文件')
        return yaml.load(source.read(1024 * 1024 + 1), Loader=UniqueLoader)


def read_permissions(file, full_passwords=()):
    return validate_policy(load_policy(file), full_passwords)


def validate_policy(value, full_passwords=()):
    fields(value, ('companies',))
    companies = value.get('companies', {})
    if not isinstance(companies, dict) or len(companies) > 500:
        raise ValueError('companies 必须是公司名称映射')
    records, passwords, count = [], set(full_passwords) - {None, ''}, 0
    for company, company_data in companies.items():
        name(company); fields(company_data, ('departments',))
        departments = company_data.get('departments', {})
        if not isinstance(departments, dict):
            raise ValueError('departments 必须是部门名称映射')
        for department, rule in departments.items():
            count += 1
            if count > 500:
                raise ValueError('部门数量不能超过 500')
            name(department); fields(rule, ('enabled', 'password', 'api_versions'))
            enabled = rule.get('enabled', True)
            if type(enabled) is not bool:
                raise ValueError('enabled 必须是 true 或 false')
            api = versions(rule.get('api_versions', []))
            if not enabled:
                continue
            password = rule.get('password')
            if not isinstance(password, str) or not 16 <= len(password) <= 1024 or password != password.strip() or re.search(r'[\x00-\x1f\x7f]', password):
                raise ValueError('启用部门的密码须为 16 至 1024 个字符，且不含首尾空白或控制字符')
            if password in passwords:
                raise ValueError('部门密码不能重复，也不能与管理员或全权限访问码相同')
            passwords.add(password)
            records.append({'company': company, 'department': department, 'password': password,
                            'api_versions': api})
    return records


def main():
    parser = argparse.ArgumentParser(description='检查 config/permissions.yaml；不输出密码。')
    parser.add_argument('--file', type=Path, default=config_file('access').parent / 'permissions.yaml')
    parser.add_argument('--json', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--applicants', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        access = read_config()['api_docs']['access']
        records = read_permissions(args.file, [access.get('password'), access.get('admin_password')])
        if args.applicants:
            from applicant_credentials import scopes
            records += scopes(records, [access.get('password'), access.get('admin_password')])
        if args.json:
            print(json.dumps(records, ensure_ascii=False))
        else:
            print(f'权限配置有效：{len(records)} 个启用部门。')
            available = json.loads((Path(os.environ.get('API_DOCS_CONTENT_ROOT', str(ROOT / 'var/content'))) / 'versions.json').read_text())['versions']
            ids = {item['id'] for item in available}
            unknown = sorted({version for rule in records for version in rule['api_versions']} - ids)
            print('可授权的 API 文档版本：' + '、'.join(item['id'] for item in available))
            if unknown:
                print('尚未发布的 API 文档版本（发布前不可访问）：' + '、'.join(unknown))
    except Exception:
        print('权限配置无效：请检查层级、字段、版本列表及密码是否重复；私有内容未输出。', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
