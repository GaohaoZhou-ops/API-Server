#!/usr/bin/env python3
"""Individual access credentials, administrator previews and durable delivery."""
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import time
from urllib.parse import urlsplit, urlunsplit

from access_requests import connect
from feedback import IDENTIFIER, InputError, utc_now, valid_email
from permissions import load_policy, validate_policy
from runtime import config_location, config_lock, lock_file, read_unlocked
from visit_email import settings, deliver, SetupError

PUBLIC_FIELDS = ('id', 'company', 'department', 'authorized_at', 'mail_status', 'attempts', 'last_attempt_at', 'mail_result')


def public_grant(row):
    return {**{key: row[key] for key in PUBLIC_FIELDS},
            'credential_type': 'individual' if row['credential_id'] else 'department'} if row else None


def request_token(db, row):
    secret = db.execute("SELECT value FROM metadata WHERE key='rate_secret'").fetchone()[0]
    data = json.dumps(['request-review-v1', *[row[key] for key in ('sequence', 'id', 'name', 'email', 'organization')]], ensure_ascii=False)
    return hmac.new(bytes.fromhex(secret), data.encode(), hashlib.sha256).hexdigest()


def fingerprint(db, company, department, rule):
    secret = db.execute("SELECT value FROM metadata WHERE key='rate_secret'").fetchone()[0]
    data = json.dumps(['access-grant-v1', company, department, rule], sort_keys=True, ensure_ascii=False)
    return hmac.new(bytes.fromhex(secret), data.encode(), hashlib.sha256).hexdigest()


def mail_settings(docs, recipient):
    if not valid_email(recipient):
        raise SetupError('Invalid stored recipient')
    # The stored application is the only source of the recipient. Browser input
    # cannot supply a destination, a password or a mail body.
    config = settings({**docs, 'email': {**docs['email'], 'recipient': recipient}})
    if not config['enabled']:
        raise InputError(409, '邮件发送已关闭，请先启用邮件配置。')
    config['access_password'] = ''
    url = urlsplit(docs['email'].get('access_url') or config['url'])
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
        raise SetupError('Invalid configured access URL')
    config['url'] = urlunsplit((url.scheme, url.netloc, '/', '', ''))
    return config


def target(data, policy):
    for key in ('id', 'operation_id'):
        if not isinstance(data.get(key), str) or not IDENTIFIER.fullmatch(data[key]):
            raise InputError(400, '申请或授权编号无效。')
    expected = data.get('expected_grant_id')
    if expected is not None and (not isinstance(expected, str) or not IDENTIFIER.fullmatch(expected)):
        raise InputError(400, '授权记录编号无效。')
    company, department = data.get('company'), data.get('department')
    if not isinstance(company, str) or not isinstance(department, str):
        raise InputError(400, '请选择已有的公司和部门。')
    rule = policy.get('companies', {}).get(company, {}).get('departments', {}).get(department)
    if not rule or not rule.get('enabled', True) or not rule.get('password'):
        raise InputError(400, '请选择已启用且配置密码的公司和部门。')
    return company, department, rule


def reviewed_request(db, data):
    request = db.execute('SELECT * FROM requests WHERE id=?', (data['id'],)).fetchone()
    if not request:
        raise InputError(404, '申请记录不存在。')
    token = data.get('request_token')
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token) or not hmac.compare_digest(token, request_token(db, request)):
        raise InputError(409, '申请记录已变化，请刷新并核对申请人后重试。')
    return request


def generate(data, docs, policy):
    """Save a short-lived preview; generating never enables login or sends mail."""
    company, department, rule = target(data, policy)
    db = connect()
    try:
        db.execute('BEGIN IMMEDIATE')
        request = reviewed_request(db, data)
        now = int(time.time())
        db.execute('DELETE FROM credential_drafts WHERE created_ts<?', (now-1800,))
        signature = fingerprint(db, company, department, rule)
        old = db.execute('SELECT * FROM credential_drafts WHERE request_sequence=?', (request['sequence'],)).fetchone()
        if old and old['id'] == data['operation_id']:
            if old['company'] != company or old['department'] != department or old['policy_fingerprint'] != signature:
                raise InputError(409, '密码生成的归属或权限已变化，请重新生成。')
            password, created = old['password'], old['created_ts']
        else:
            if db.execute('SELECT 1 FROM credential_drafts WHERE id=?', (data['operation_id'],)).fetchone():
                raise InputError(409, '密码生成编号已使用，请重新生成。')
            reserved = [docs['access'].get('password'), docs['access'].get('admin_password')]
            reserved += [r.get('password') for c in policy.get('companies', {}).values() for r in c.get('departments', {}).values()]
            while True:
                password = secrets.token_urlsafe(24)
                if password not in reserved and not db.execute('SELECT 1 FROM credential_drafts WHERE password=?', (password,)).fetchone() and not db.execute('SELECT 1 FROM applicant_credentials WHERE password_hash=?',
                        (hashlib.sha256(password.encode()).hexdigest(),)).fetchone():
                    break
            created = now
            db.execute('DELETE FROM credential_drafts WHERE request_sequence=?', (request['sequence'],))
            db.execute('INSERT INTO credential_drafts VALUES (?,?,?,?,?,?,?)',
                       (request['sequence'], data['operation_id'], company, department, password, created, signature))
        db.commit()
        return {'password': password, 'draft_id': data['operation_id'],
                'expires_at': datetime.fromtimestamp(created+1800, timezone.utc).isoformat(timespec='seconds')}
    finally:
        db.close()


def authorize(data, docs, policy):
    """Only called after administrator, revision and field checks under config lock."""
    company, department, rule = target(data, policy)
    expected = data.get('expected_grant_id')
    db = connect()
    try:
        db.execute('BEGIN IMMEDIATE')
        request = reviewed_request(db, data)
        old = db.execute('SELECT * FROM request_grants WHERE request_sequence=?', (request['sequence'],)).fetchone()
        if old and old['id'] == data['operation_id']:
            if old['company'] != company or old['department'] != department:
                raise InputError(409, '同一授权提交的部门不能改变，请刷新记录。')
            return {'queued': False, 'authorization': public_grant(old)}
        if (old['id'] if old else None) != expected:
            raise InputError(409, '申请的授权记录已更新，请刷新面板后重试。')
        if old and old['mail_status'] == 'sending':
            raise InputError(409, '授权邮件正在发送，请稍后刷新记录。')
        if old and int(time.time()) - old['authorized_ts'] < 30:
            raise InputError(429, '授权提交过于频繁，请 30 秒后重试。')
        if db.execute('SELECT 1 FROM request_grants WHERE id=?', (data['operation_id'],)).fetchone():
            raise InputError(409, '授权提交编号已使用，请刷新面板。')
        draft_id = data.get('draft_id')
        if not isinstance(draft_id, str) or not IDENTIFIER.fullmatch(draft_id):
            raise InputError(400, '请先生成申请人的独立密码。')
        draft = db.execute('SELECT * FROM credential_drafts WHERE id=? AND request_sequence=?', (draft_id, request['sequence'])).fetchone()
        if not draft or draft['created_ts'] < int(time.time())-1800 or draft['company'] != company or draft['department'] != department or not hmac.compare_digest(
                draft['policy_fingerprint'], fingerprint(db, company, department, rule)):
            raise InputError(409, '生成的密码已失效或归属已变更，请重新生成。')
        try:
            mail_settings(docs, request['email'])
        except SetupError:
            raise InputError(409, '邮件配置不完整，请先检查发件邮箱、授权码和访问地址。')
        db.execute('DELETE FROM request_grants WHERE request_sequence=?', (request['sequence'],))
        db.execute('''INSERT INTO request_grants
            (request_sequence,id,company,department,authorized_at,authorized_ts,policy_fingerprint,credential_id,delivery_password)
            VALUES (?,?,?,?,?,?,?,?,?)''', (request['sequence'], data['operation_id'], company, department,
                utc_now(), int(time.time()), fingerprint(db, company, department, rule), draft_id, draft['password']))
        db.execute('DELETE FROM applicant_credentials WHERE request_sequence=?', (request['sequence'],))
        db.execute('''INSERT INTO applicant_credentials (id,request_sequence,company,department,password_hash,created_at)
            VALUES (?,?,?,?,?,?)''', (draft_id, request['sequence'], company, department,
                   hashlib.sha256(draft['password'].encode()).hexdigest(), utc_now()))
        from credential_vault import seal
        credential = db.execute('SELECT * FROM applicant_credentials WHERE id=?', (draft_id,)).fetchone()
        db.execute('UPDATE applicant_credentials SET password_encrypted=? WHERE id=?',
                   (seal(db, credential, draft['password']), draft_id))
        db.execute('DELETE FROM credential_drafts WHERE request_sequence=?', (request['sequence'],))
        row = db.execute('SELECT * FROM request_grants WHERE request_sequence=?', (request['sequence'],)).fetchone()
        db.commit()
        return {'queued': True, 'authorization': public_grant(row)}
    finally:
        db.close()


def view_current(data, policy):
    """Read the reviewed applicant's active credential, never a generated draft."""
    if not isinstance(data.get('id'), str) or not IDENTIFIER.fullmatch(data['id']):
        raise InputError(400, '申请编号无效。')
    expected = data.get('expected_grant_id')
    if expected is not None and (not isinstance(expected, str) or not IDENTIFIER.fullmatch(expected)):
        raise InputError(400, '授权记录编号无效。')
    db = connect()
    try:
        db.execute('BEGIN')
        request = reviewed_request(db, data)
        grant = db.execute('SELECT * FROM request_grants WHERE request_sequence=?', (request['sequence'],)).fetchone()
        if (grant['id'] if grant else None) != expected:
            raise InputError(409, '申请的授权记录已更新，请刷新面板后重试。')
        if not grant:
            return {'passwords': [], 'notice': '该申请尚未授权，没有当前密码。'}
        company, department = grant['company'], grant['department']
        rule = policy.get('companies', {}).get(company, {}).get('departments', {}).get(department)
        enabled = bool(rule and rule.get('enabled', True) and rule.get('password'))
        if grant['credential_id']:
            credential = db.execute('SELECT * FROM applicant_credentials WHERE id=? AND request_sequence=?',
                                    (grant['credential_id'], request['sequence'])).fetchone()
            if not credential or (credential['company'], credential['department']) != (company, department):
                raise InputError(409, '申请的授权记录已更新，请刷新面板后重试。')
            if not credential['password_encrypted']:
                return {'passwords': [], 'notice': '这条旧授权未保留可查看的密码。请先生成新密码并重新授权，再查看当前密码。'}
            try:
                from credential_vault import reveal
                password = reveal(db, credential)
            except Exception:
                raise InputError(503, '当前密码暂无法读取，请检查服务器密码密钥。') from None
            notice = '这是该申请人已授权的独立密码。生成新密码不会改变它，重新授权后才会替换。'
        else:
            if not rule or not rule.get('password'):
                return {'passwords': [], 'notice': '原授权部门不存在或未设置密码，当前没有可查看的部门密码。'}
            password = rule['password']
            notice = '这条旧授权使用部门共用密码，显示的是该部门当前的密码。'
        if not enabled:
            notice += '所属部门已停用或不存在，此密码暂不可登录。'
        return {'passwords': [{'kind': 'applicant' if grant['credential_id'] else 'department',
                              'company': company, 'department': department, 'password': password}], 'notice': notice}
    finally:
        db.close()


def message(config, record, rule):
    mail = EmailMessage()
    mail['Subject'] = 'Documentation Platform API空间 · 访问授权'
    mail['From'], mail['To'] = config['sender'], config['recipient']
    mail['Date'] = format_datetime(datetime.now(timezone.utc))
    mail['Message-ID'] = '<access-grant-' + record['id'] + '@' + config['sender'].rsplit('@', 1)[-1] + '>'
    mail['Auto-Submitted'] = 'auto-generated'
    lines = [record['name'] + '，您好：', '', '管理员已确认您的访问申请。',
             '公司：' + record['company'], '部门：' + record['department'],
             '文档入口：' + config['url'], '访问密码：' + rule['password'], '',
             '打开上述网址，填写您的姓名和机构，并输入访问密码登录。',
             '可访问内容按该部门的当前权限配置生效。请妥善保管密码。']
    for key, label in [('api_versions', 'API 文档')]:
        lines.append(label + '：' + ('、'.join(rule.get(key, [])) or '未授权'))
    mail.set_content('\n'.join(lines))
    return mail


def send_next():
    db = connect()
    try:
        now = int(time.time())
        # Lock order matches admin_panel: configuration, then the application DB.
        descriptor = lock_file(config_lock(config_location()))
        try:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM credential_drafts WHERE created_ts<?', (now-1800,))
            db.execute("UPDATE request_grants SET mail_status='uncertain',mail_result='interrupted' WHERE mail_status='sending' AND next_attempt_ts<?", (now - 120,))
            row = db.execute('''SELECT g.*, r.name, r.email FROM request_grants g
                JOIN requests r ON r.sequence=g.request_sequence
                WHERE g.mail_status IN ('pending','failed') AND g.attempts<3 AND g.next_attempt_ts<=?
                ORDER BY g.authorized_ts, g.request_sequence LIMIT 1''', (now,)).fetchone()
            if not row:
                db.commit()
                return {'processed': False}
            record = dict(row)
            db.execute("UPDATE request_grants SET mail_status='sending',attempts=attempts+1,last_attempt_at=?,next_attempt_ts=? WHERE id=?", (utc_now(), now, record['id']))
            result, mail = None, None
            try:
                docs = read_unlocked(config_location())['api_docs']
                policy = load_policy(config_location() / 'permissions.yaml')
                validate_policy(policy, [docs['access'].get('password'), docs['access'].get('admin_password')])
                rule = policy.get('companies', {}).get(record['company'], {}).get('departments', {}).get(record['department'])
                if not rule or not rule.get('enabled', True) or not hmac.compare_digest(
                        fingerprint(db, record['company'], record['department'], rule), record['policy_fingerprint']):
                    result = 'policy_changed'
                else:
                    config = mail_settings(docs, record['email'])
                    password = rule['password']
                    if record['credential_id']:
                        credential = db.execute('SELECT * FROM applicant_credentials WHERE id=?', (record['credential_id'],)).fetchone()
                        password = record['delivery_password']
                        if not credential or not password or not hmac.compare_digest(credential['password_hash'], hashlib.sha256(password.encode()).hexdigest()):
                            raise ValueError('Credential no longer current')
                    mail = message(config, record, {**rule, 'password': password})
            except InputError:
                result = 'disabled'
            except SetupError:
                result = 'not_configured'
            except Exception:
                result = 'policy_changed'
            db.commit()
        finally:
            os.close(descriptor)
        # Never keep configuration locks during network I/O. A message already
        # handed to SMTP cannot be recalled by a later permission change/clear.
        if mail is not None:
            try:
                deliver(config, mail)
                result = 'accepted'
            except smtplib.SMTPAuthenticationError:
                result = 'auth_failed'
            except smtplib.SMTPRecipientsRefused:
                result = 'recipient_rejected'
            except ssl.SSLError:
                result = 'tls_failed'
            except Exception:
                result = 'failed'
        status = 'cancelled' if result == 'policy_changed' else result if result in ('accepted', 'disabled') else 'failed'
        db.execute('UPDATE request_grants SET mail_status=?,mail_result=?,next_attempt_ts=?,delivery_password=CASE WHEN ? THEN NULL ELSE delivery_password END WHERE id=? AND request_sequence=?',
                   (status, result, now + (60 if record['attempts'] == 0 else 300), result == 'accepted', record['id'], record['request_sequence']))
        db.commit()
        return {'processed': True, 'status': status}
    finally:
        db.close()
