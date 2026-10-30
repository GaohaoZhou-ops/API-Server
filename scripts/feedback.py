#!/usr/bin/env python3
"""Private feedback storage and administrator-only mail delivery."""
import argparse
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime
import json
import os
import re
import smtplib
import sqlite3
import ssl
import stat
import sys
import time

from runtime import STATE, read_config
from visit_email import settings, deliver, SetupError
from feedback_images import validate as validate_images, ImageError, MAX_REQUEST_BYTES
import email_layout as layout

FIELDS = ('name', 'email', 'organization', 'category', 'message', 'document_version')
CATEGORIES = ('使用问题', '接口与文档', '机器人模型', 'Web/APP UI', '功能建议', '其他')
IDENTIFIER = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
LABELS = {'pending': '待发送', 'sending': '发送中', 'accepted': '邮件已受理',
          'failed': '发送失败', 'disabled': '通知已关闭', 'uncertain': '发送结果待确认'}


class InputError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def connect():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE, 0o700)
    file = STATE / 'feedback.sqlite3'
    fd = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Invalid feedback storage')
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    db = sqlite3.connect(file, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    db.execute('BEGIN IMMEDIATE')
    version = db.execute('PRAGMA user_version').fetchone()[0]
    if version not in (0, 1, 2):
        db.close()
        raise ValueError('Unsupported feedback database')
    db.execute('''CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, created_ts INTEGER NOT NULL,
        name TEXT NOT NULL, email TEXT NOT NULL, organization TEXT NOT NULL,
        category TEXT NOT NULL, message TEXT NOT NULL, document_version TEXT NOT NULL,
        rate_key TEXT NOT NULL, mail_status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
        next_attempt_ts INTEGER NOT NULL DEFAULT 0, mail_result TEXT)''')
    db.execute('CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created_ts)')
    db.execute('''CREATE TABLE IF NOT EXISTS feedback_attachments (
        feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
        sha256 TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(feedback_id,position))''')
    db.execute('PRAGMA user_version = 2')
    db.commit()
    return db


def valid_email(value):
    if not isinstance(value, str) or len(value) > 254 or value.count('@') != 1:
        return False
    local, domain = value.split('@')
    return (1 <= len(local) <= 64 and not local.startswith('.') and not local.endswith('.') and '..' not in local
            and bool(re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+", local))
            and '.' in domain and all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', part)
                                     for part in domain.split('.')))


def validate(value):
    if not isinstance(value, dict) or not IDENTIFIER.fullmatch(str(value.get('submission_id', ''))):
        raise InputError(400, '提交标识无效，请重新打开留言页。')
    result = {}
    for key, label, maximum in [('name', '姓名', 80), ('email', '邮箱', 254), ('organization', '单位', 160), ('message', '留言内容', 3000)]:
        raw = value.get(key)
        if not isinstance(raw, str) or not raw.strip() or len(raw.strip()) > maximum:
            raise InputError(400, f'请填写{label}，最多 {maximum} 个字符。')
        cleaned = raw.strip().replace('\r\n', '\n')
        if any((ord(char) < 32 and not (key == 'message' and char in '\n\t')) or 127 <= ord(char) <= 159 for char in cleaned):
            raise InputError(400, f'{label}含有不支持的字符。')
        result[key] = cleaned
    if not valid_email(result['email']):
        raise InputError(400, '请填写有效的邮箱地址。')
    result['email'] = result['email'].rsplit('@', 1)[0] + '@' + result['email'].rsplit('@', 1)[1].lower()
    result['category'] = value.get('category', '使用问题')
    if result['category'] not in CATEGORIES:
        raise InputError(400, '请选择有效的反馈类型。')
    result['document_version'] = value.get('document_version', '')
    if not isinstance(result['document_version'], str) or not re.fullmatch(r'[a-zA-Z0-9.-]{0,64}', result['document_version']):
        raise InputError(400, '文档版本无效，请刷新后重试。')
    if not re.fullmatch(r'[a-f0-9]{64}', str(value.get('rate_key', ''))):
        raise InputError(400, '提交校验失败，请重试。')
    return result


def submit(value):
    fields = validate(value)
    try:
        attachments = validate_images(value.get('attachments', []))
    except ImageError as error:
        raise InputError(error.status, error.message) from None
    db = connect()
    try:
        # Serialize quota checks and insertion; a retried request never creates a second record.
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT * FROM feedback WHERE id=?', (value['submission_id'],)).fetchone()
        if previous:
            saved = [dict(row) for row in db.execute('SELECT name,mime,sha256 FROM feedback_attachments WHERE feedback_id=? ORDER BY position', (previous['id'],))]
            identity = [{key: item[key] for key in ('name', 'mime', 'sha256')} for item in attachments]
            if any(previous[key] != fields[key] for key in FIELDS) or saved != identity:
                raise InputError(409, '重复提交的内容已变化，请重新提交。')
            return {'id': previous['id'], 'created_at': previous['created_at']}
        now = int(time.time())
        counts = db.execute('''SELECT COUNT(*) AS total,
            COALESCE(SUM(LOWER(email)=LOWER(?)),0) AS same_email,
            COALESCE(SUM(rate_key=? AND created_ts>=?),0) AS same_client
            FROM feedback WHERE created_ts>=?''', (fields['email'], value['rate_key'], now-600, now-3600)).fetchone()
        if counts['total'] >= 120 or counts['same_email'] >= 5 or counts['same_client'] >= 5:
            raise InputError(429, '提交过于频繁，请稍后再试。')
        created = utc_now()
        db.execute('INSERT INTO feedback (id,created_at,created_ts,' + ','.join(FIELDS) + ',rate_key) VALUES (' + ','.join('?' for _ in range(10)) + ')',
                   [value['submission_id'], created, now] + [fields[key] for key in FIELDS] + [value['rate_key']])
        db.executemany('INSERT INTO feedback_attachments VALUES (?,?,?,?,?,?)',
            [(value['submission_id'], position, item['name'], item['mime'], item['sha256'], item['data']) for position, item in enumerate(attachments)])
        db.commit()
        return {'id': value['submission_id'], 'created_at': created}
    finally:
        db.close()


def message(config, record, attachments=()):
    mail = EmailMessage()
    mail['Subject'] = 'API Docs · 新留言反馈'
    mail['From'], mail['To'] = config['sender'], config['recipient']
    # Reply-To helps the administrator follow up; it never controls the SMTP destination.
    mail['Reply-To'] = record['email']
    mail['Date'] = format_datetime(datetime.now(timezone.utc))
    mail['Message-ID'] = '<feedback-' + record['id'] + '@' + config['sender'].rsplit('@', 1)[-1] + '>'
    mail['Auto-Submitted'] = 'auto-generated'
    mail.set_content('\n'.join(['收到一条新的 API Docs 留言。', '编号：' + record['id'],
        '提交时间：' + layout.display_time(record['created_at']), '姓名：' + record['name'], '邮箱：' + record['email'],
        '单位：' + record['organization'], '类型：' + record['category'], '文档版本：' + (record['document_version'] or '未选择 API 文档'),
        '', '留言内容：', record['message'], '', '截图附件：' + str(len(attachments)) + ' 张', '联系信息由提交者填写，尚未验证。']))
    body = layout.section('留言内容', layout.paragraph(record['message']))
    body += layout.section('提交信息', layout.details([
        ('姓名', record['name']), ('邮箱', record['email']), ('单位', record['organization']),
        ('反馈类型', record['category']), ('文档版本', record['document_version'] or '未选择 API 文档'),
        ('提交时间', layout.display_time(record['created_at'])), ('留言编号', record['id'])]))
    body += layout.section(f'截图附件 · {len(attachments)} 张',
        layout.details([(f'附件 {index}', item['name']) for index, item in enumerate(attachments, 1)]) if attachments
        else layout.paragraph('本次留言未上传截图。', True))
    footer = '联系信息由提交者填写，尚未验证。可直接回复本邮件联系提交者；截图以原始附件提供。时间为北京时间（UTC+8）。'
    mail.add_alternative(layout.document('新留言反馈', '收到一条新的 API Docs 留言。', body, footer), subtype='html')
    for attachment in attachments:
        mail.add_attachment(attachment['data'], maintype='image', subtype=attachment['mime'].split('/')[1], filename=attachment['name'])
    return mail


def send_next():
    db = connect()
    try:
        now = int(time.time())
        db.execute('BEGIN IMMEDIATE')
        # A crash after SMTP acceptance is ambiguous: keep it for explicit administrator review.
        db.execute("UPDATE feedback SET mail_status='uncertain',mail_result='interrupted' WHERE mail_status='sending' AND next_attempt_ts<?", (now-120,))
        row = db.execute("SELECT * FROM feedback WHERE mail_status IN ('pending','failed') AND attempts<3 AND next_attempt_ts<=? ORDER BY created_ts,rowid LIMIT 1", (now,)).fetchone()
        if not row:
            db.commit()
            return {'processed': False}
        record = dict(row)
        db.execute("UPDATE feedback SET mail_status='sending',attempts=attempts+1,last_attempt_at=?,next_attempt_ts=? WHERE id=?", (utc_now(), now, record['id']))
        db.commit()
        try:
            docs = read_config()['api_docs']
            if docs['email']['enabled'] is False:
                result = 'disabled'
            else:
                config = settings(docs)
                config['smtp_timeout'] = 60
                attachments = db.execute('SELECT name,mime,data FROM feedback_attachments WHERE feedback_id=? ORDER BY position', (record['id'],)).fetchall()
                deliver(config, message(config, record, attachments))
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
        retry = now + (60 if record['attempts'] == 0 else 300)
        db.execute('UPDATE feedback SET mail_status=?,mail_result=?,next_attempt_ts=? WHERE id=?', (status, result, retry, record['id']))
        db.commit()
        return {'processed': True, 'status': status}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description='服务器管理员查看与重试留言；不显示管理员收件邮箱。')
    parser.add_argument('command', choices=['submit', 'send-next', 'list', 'show', 'retry'])
    parser.add_argument('id', nargs='?')
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    if args.command == 'submit':
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES+1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise InputError(413, '留言内容过大。')
        print(json.dumps({'ok': True, **submit(json.loads(raw))}))
        return
    if args.command == 'send-next':
        print(json.dumps(send_next()))
        return
    if not 1 <= args.limit <= 200:
        parser.error('--limit 须为 1 至 200')
    if args.command != 'list' and not IDENTIFIER.fullmatch(args.id or ''):
        parser.error('请提供有效的留言编号')
    db = connect()
    try:
        if args.command == 'retry':
            db.execute('BEGIN IMMEDIATE')
        if args.command == 'list':
            rows = db.execute('SELECT * FROM feedback ORDER BY created_ts DESC,rowid DESC LIMIT ?', (args.limit,)).fetchall()
            if not rows:
                print('暂无留言。')
            for row in rows:
                print(f'{row["id"]} | {row["created_at"]} | {row["name"]} | {row["organization"]} | {LABELS[row["mail_status"]]}')
        else:
            row = db.execute('SELECT * FROM feedback WHERE id=?', (args.id,)).fetchone()
            if not row:
                parser.exit(3, '未找到该留言。\n')
            if args.command == 'show':
                for key, label in [('id', '编号'), ('created_at', '时间（UTC）'), ('name', '姓名'), ('email', '邮箱'), ('organization', '单位'), ('category', '类型'), ('document_version', '文档版本'), ('message', '留言')]:
                    print(label + '：' + row[key])
                print('邮件状态：' + LABELS[row['mail_status']] + '；尝试次数：' + str(row['attempts']))
                for item in db.execute('SELECT name,length(data) AS size FROM feedback_attachments WHERE feedback_id=? ORDER BY position', (args.id,)):
                    print('截图附件：' + item['name'] + '（' + str(item['size']) + ' 字节）')
            elif row['mail_status'] in ('accepted', 'sending'):
                print('邮件已受理或正在发送，不重复发送。')
            else:
                db.execute("UPDATE feedback SET mail_status='pending',attempts=0,next_attempt_ts=0,mail_result=NULL WHERE id=?", (args.id,))
                db.commit()
                print('已加入重试队列；服务运行时自动发送。')
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except InputError as error:
        print(json.dumps({'ok': False, 'status': error.status, 'error': error.message}, ensure_ascii=False))
    except Exception:
        # Config, SMTP and database exceptions may contain addresses or submitted text.
        print('留言操作失败，请检查服务状态和私有配置。', file=sys.stderr)
        sys.exit(1)
