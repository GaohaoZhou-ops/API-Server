#!/usr/bin/env python3
"""Private access applications and their durable administrator mail queue."""
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime
import hashlib
import hmac
import json
import os
import secrets
import smtplib
import sqlite3
import ssl
import stat
import sys
import time
import unicodedata

from feedback import IDENTIFIER, InputError, valid_email, utc_now
from runtime import STATE, read_config
from visit_email import settings, deliver, SetupError
import email_layout as layout

FIELDS = ('name', 'email', 'organization')
PAGE_SIZE = 10


def connect():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE, 0o700)
    file = STATE / 'access-requests.sqlite3'
    fd = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Invalid application storage')
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    db = sqlite3.connect(file, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA secure_delete = ON')
    db.execute('PRAGMA foreign_keys = ON')
    db.execute('BEGIN IMMEDIATE')
    if db.execute('PRAGMA user_version').fetchone()[0] not in (0, 1, 2, 3, 4):
        db.close()
        raise ValueError('Unsupported application database')
    db.execute('''CREATE TABLE IF NOT EXISTS requests (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, created_ts INTEGER NOT NULL,
        name TEXT NOT NULL, email TEXT NOT NULL, organization TEXT NOT NULL,
        rate_key TEXT NOT NULL, mail_status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
        next_attempt_ts INTEGER NOT NULL DEFAULT 0, mail_result TEXT)''')
    db.execute('CREATE INDEX IF NOT EXISTS requests_created ON requests(created_ts)')
    db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.execute('INSERT OR IGNORE INTO metadata VALUES (?,?)', ('rate_secret', secrets.token_hex(32)))
    db.execute('''CREATE TABLE IF NOT EXISTS request_grants (
        request_sequence INTEGER PRIMARY KEY REFERENCES requests(sequence) ON DELETE CASCADE,
        id TEXT NOT NULL UNIQUE, company TEXT NOT NULL, department TEXT NOT NULL,
        authorized_at TEXT NOT NULL, authorized_ts INTEGER NOT NULL, policy_fingerprint TEXT NOT NULL,
        mail_status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT, next_attempt_ts INTEGER NOT NULL DEFAULT 0, mail_result TEXT)''')
    columns = {row['name'] for row in db.execute('PRAGMA table_info(request_grants)')}
    for column in ('credential_id', 'delivery_password'):
        if column not in columns:
            db.execute('ALTER TABLE request_grants ADD COLUMN ' + column + ' TEXT')
    db.execute('''CREATE TABLE IF NOT EXISTS credential_drafts (
        request_sequence INTEGER PRIMARY KEY REFERENCES requests(sequence) ON DELETE CASCADE,
        id TEXT NOT NULL UNIQUE, company TEXT NOT NULL, department TEXT NOT NULL,
        password TEXT NOT NULL, created_ts INTEGER NOT NULL, policy_fingerprint TEXT NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS applicant_credentials (
        id TEXT PRIMARY KEY, request_sequence INTEGER NOT NULL UNIQUE,
        company TEXT NOT NULL, department TEXT NOT NULL,
        password_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)''')
    if 'password_encrypted' not in {row['name'] for row in db.execute('PRAGMA table_info(applicant_credentials)')}:
        db.execute('ALTER TABLE applicant_credentials ADD COLUMN password_encrypted TEXT')
        from credential_vault import preserve_queued
        preserve_queued(db)
    db.execute('PRAGMA user_version = 4')
    db.commit()
    return db


def validate(value):
    if not isinstance(value, dict) or not IDENTIFIER.fullmatch(str(value.get('submission_id', ''))):
        raise InputError(400, '提交标识无效，请重新打开申请表。')
    result = {}
    for key, label, maximum in [('name', '姓名', 80), ('email', '邮箱', 254), ('organization', '机构', 160)]:
        raw = value.get(key)
        if not isinstance(raw, str) or not raw.strip() or len(raw.strip()) > maximum:
            raise InputError(400, f'请填写{label}，最多 {maximum} 个字符。')
        if any(unicodedata.category(char) in ('Cc', 'Cs', 'Zl', 'Zp') for char in raw):
            raise InputError(400, f'{label}含有不支持的字符。')
        result[key] = raw.strip()
    if not valid_email(result['email']):
        raise InputError(400, '请填写有效的邮箱地址。')
    local, domain = result['email'].rsplit('@', 1)
    result['email'] = local + '@' + domain.lower()
    return result


def submit(value):
    fields = validate(value)
    ip = value.get('ip')
    if not isinstance(ip, str) or not 1 <= len(ip) <= 128:
        raise InputError(400, '提交校验失败，请重试。')
    db = connect()
    try:
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT * FROM requests WHERE id=?', (value['submission_id'],)).fetchone()
        if previous:
            if any(previous[key] != fields[key] for key in FIELDS):
                raise InputError(409, '重复申请的内容已变化，请重新提交。')
            return {'id': previous['id'], 'created_at': previous['created_at']}
        secret = db.execute("SELECT value FROM metadata WHERE key='rate_secret'").fetchone()[0]
        rate_key = hmac.new(bytes.fromhex(secret), ip.encode(), hashlib.sha256).hexdigest()
        now = int(time.time())
        counts = db.execute('''SELECT COUNT(*) AS total,
            COALESCE(SUM(LOWER(email)=LOWER(?)),0) AS same_email,
            COALESCE(SUM(rate_key=? AND created_ts>=?),0) AS same_client
            FROM requests WHERE created_ts>=?''', (fields['email'], rate_key, now-600, now-3600)).fetchone()
        if counts['total'] >= 60 or counts['same_email'] >= 3 or counts['same_client'] >= 5:
            raise InputError(429, '申请过于频繁，请稍后再试。')
        created = utc_now()
        db.execute('INSERT INTO requests (id,created_at,created_ts,name,email,organization,rate_key) VALUES (?,?,?,?,?,?,?)',
                   [value['submission_id'], created, now, fields['name'], fields['email'], fields['organization'], rate_key])
        db.commit()
        return {'id': value['submission_id'], 'created_at': created}
    finally:
        db.close()


def page(value):
    number, snapshot = value.get('page', 1), value.get('snapshot')
    if type(number) is not int or not 1 <= number <= 9007199254740991 or (
            snapshot is not None and (type(snapshot) is not int or not 0 <= snapshot <= 9007199254740991)):
        raise InputError(400, '申请记录分页参数无效。')
    db = connect()
    try:
        db.execute('BEGIN')
        maximum = db.execute('SELECT COALESCE(MAX(sequence),0) FROM requests').fetchone()[0]
        snapshot = maximum if snapshot is None else min(snapshot, maximum)
        total = db.execute('SELECT COUNT(*) FROM requests WHERE sequence<=?', (snapshot,)).fetchone()[0]
        pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
        number = min(number, pages)
        rows = db.execute('''SELECT sequence,id,created_at,name,email,organization,mail_status,attempts,last_attempt_at,mail_result
            FROM requests WHERE sequence<=? ORDER BY sequence DESC LIMIT ? OFFSET ?''',
            (snapshot, PAGE_SIZE, (number - 1) * PAGE_SIZE)).fetchall()
        from access_grants import public_grant, request_token
        records = []
        for row in rows:
            record = dict(row)
            record['request_token'] = request_token(db, row)
            sequence = record.pop('sequence')
            record['authorization'] = public_grant(db.execute(
                'SELECT * FROM request_grants WHERE request_sequence=?', (sequence,)).fetchone())
            records.append(record)
        return {'page': number, 'pages': pages, 'total': total, 'limit': PAGE_SIZE,
                'snapshot': snapshot, 'requests': records}
    finally:
        db.close()


def retry(value):
    identifier = value.get('id')
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        raise InputError(400, '申请编号无效。')
    # Revalidate the administrator credential inside the private IPC worker.
    password = read_config()['api_docs']['access'].get('admin_password')
    signature = value.get('admin_signature')
    if not isinstance(password, str) or not password or not isinstance(signature, str) or not hmac.compare_digest(
            hashlib.sha256(password.encode()).hexdigest(), signature):
        raise InputError(401, '管理员登录已失效，请重新登录。')
    db = connect()
    try:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT mail_status FROM requests WHERE id=?', (identifier,)).fetchone()
        if not row:
            raise InputError(404, '申请记录不存在。')
        if row['mail_status'] in ('pending', 'sending', 'accepted'):
            return {'queued': False}
        db.execute("UPDATE requests SET mail_status='pending',attempts=0,next_attempt_ts=0,mail_result=NULL WHERE id=?", (identifier,))
        db.commit()
        return {'queued': True}
    finally:
        db.close()


def clear():
    """Called only by admin_panel after password verification under its config lock."""
    db = connect()
    try:
        db.execute('BEGIN IMMEDIATE')
        count = db.execute('SELECT COUNT(*) FROM requests').fetchone()[0]
        # Pending mail lives in these rows. A worker already sending may finish,
        # but its UPDATE cannot recreate a deleted application.
        db.execute('DELETE FROM requests')
        db.commit()
        return count
    finally:
        db.close()


def message(config, record):
    mail = EmailMessage()
    mail['Subject'] = 'Documentation Platform API空间 · 新访问申请'
    mail['From'], mail['To'] = config['sender'], config['recipient']
    mail['Reply-To'] = record['email']
    mail['Date'] = format_datetime(datetime.now(timezone.utc))
    mail['Message-ID'] = '<access-request-' + record['id'] + '@' + config['sender'].rsplit('@', 1)[-1] + '>'
    mail['Auto-Submitted'] = 'auto-generated'
    mail.set_content('\n'.join(['收到一条新的访问申请。', '申请编号：' + record['id'],
        '申请时间：' + layout.display_time(record['created_at']), '姓名：' + record['name'], '邮箱：' + record['email'],
        '机构：' + record['organization'], '', '可在管理员面板 → 申请记录中查看。',
        '请核实申请信息后，在申请记录中选择公司和部门，先生成密码，再点击“授权并发送密码”。申请提交本身不会授予权限。',
        '以上联系信息由申请人填写，尚未验证。']))
    body = layout.section('申请人信息', layout.details([
        ('姓名', record['name']), ('邮箱', record['email']), ('机构（填写）', record['organization']),
        ('申请时间', layout.display_time(record['created_at'])), ('申请编号', record['id'])]))
    body += layout.section('处理申请', layout.paragraph('在管理员面板的“申请记录”中核实信息，选择公司和部门，生成密码后再授权并发送。')
                           + layout.entry(config.get('url'), '打开管理员面板', admin=True))
    mail.add_alternative(layout.document('新访问申请', '收到一条新的 Documentation Platform API 空间访问申请。', body,
        '申请提交本身不会授予权限。以上联系信息由申请人填写，尚未验证。时间为北京时间（UTC+8）。'), subtype='html')
    return mail


def send_next():
    from access_grants import send_next as send_grant
    grant = send_grant()
    if grant['processed']:
        return grant
    db = connect()
    try:
        now = int(time.time())
        db.execute('BEGIN IMMEDIATE')
        # SMTP may have accepted a message just before a worker died. Do not resend blindly.
        db.execute("UPDATE requests SET mail_status='uncertain',mail_result='interrupted' WHERE mail_status='sending' AND next_attempt_ts<?", (now-120,))
        row = db.execute("SELECT * FROM requests WHERE mail_status IN ('pending','failed') AND attempts<3 AND next_attempt_ts<=? ORDER BY sequence LIMIT 1", (now,)).fetchone()
        if not row:
            db.commit()
            return {'processed': False}
        record = dict(row)
        db.execute("UPDATE requests SET mail_status='sending',attempts=attempts+1,last_attempt_at=?,next_attempt_ts=? WHERE id=?", (utc_now(), now, record['id']))
        db.commit()
        try:
            docs = read_config()['api_docs']
            if docs['email']['enabled'] is False:
                result = 'disabled'
            else:
                config = settings(docs)
                deliver(config, message(config, record))
                result = 'accepted'
        except SetupError:
            result = 'not_configured'
        except smtplib.SMTPAuthenticationError:
            result = 'auth_failed'
        except smtplib.SMTPRecipientsRefused:
            result = 'recipient_rejected'
        except ssl.SSLError:
            result = 'tls_failed'
        except Exception:
            result = 'failed'
        status = result if result in ('accepted', 'disabled') else 'failed'
        db.execute('UPDATE requests SET mail_status=?,mail_result=?,next_attempt_ts=? WHERE id=? AND sequence=?',
                   (status, result, now + (60 if record['attempts'] == 0 else 300), record['id'], record['sequence']))
        db.commit()
        return {'processed': True, 'status': status}
    finally:
        db.close()


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('submit', 'page', 'retry', 'send-next'):
        raise ValueError('Invalid private IPC command')
    command = sys.argv[1]
    if command == 'send-next':
        result = send_next()
    else:
        raw = sys.stdin.read(16385)
        if len(raw) > 16384:
            raise InputError(413, '申请内容过大。')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise InputError(400, '申请格式无效。')
        result = {'submit': submit, 'page': page, 'retry': retry}[command](value)
    print(json.dumps({'ok': True, **result}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except InputError as error:
        print(json.dumps({'ok': False, 'status': error.status, 'error': error.message}, ensure_ascii=False))
    except Exception:
        # Never log SMTP exceptions, addresses, credentials or applicant text.
        print('申请服务暂不可用，请检查服务状态和私有配置。', file=sys.stderr)
        sys.exit(1)
