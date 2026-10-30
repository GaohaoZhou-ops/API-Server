#!/usr/bin/env python3
"""Private login and password-change notifications through verified QQ SMTP."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
import getpass
import ipaddress
import json
import os
import re
import smtplib
import ssl
import sys
import tempfile

from runtime import STATE, config_file, edit_config, lock_file, read_config
import email_layout as layout

STATUS_NAME = 'visit-email-status.json'
HISTORY_NAME = 'recent-visits.json'
HISTORY_LIMIT = 10
EVENT_LABELS = {'login': '新登录', 'password_changed': '访问码变更', 'test': '发信测试'}
LOGIN_LABELS = {'department': '部门密码', 'shared': '全权限访问码', 'admin': '管理员密码'}
LABELS = {'accepted': '邮件服务器已受理', 'disabled': '通知已关闭', 'not_configured': '配置不完整',
          'auth_failed': 'QQ 邮箱授权失败，请检查授权码及 SMTP 开关', 'recipient_rejected': '收件地址被拒绝',
          'tls_failed': '加密连接校验失败', 'failed': '发送失败，请检查网络或邮箱服务'}


class SetupError(Exception):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def atomic_write(file, text):
    handle, temporary = tempfile.mkstemp(prefix='.' + file.name + '.', dir=file.parent)
    try:
        with os.fdopen(handle, 'w') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def mail_lock():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE, 0o700)
    handle = lock_file(STATE / 'visit-email.lock')
    try:
        yield
    finally:
        os.close(handle)


def email_address(value):
    return isinstance(value, str) and len(value) <= 254 and bool(re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+", value))


def settings(docs=None):
    docs = read_config()['api_docs'] if docs is None else docs
    access, email = docs['access'], docs['email']
    enabled = email['enabled']
    location = str(config_file('email'))
    if type(enabled) is not bool:
        raise SetupError(location + ' 的 enabled 必须为 true 或 false。')
    recipient, sender = email.get('recipient'), email.get('sender')
    host, port = email.get('smtp_host'), email.get('smtp_port', 465)
    security = email.get('smtp_security', 'ssl')
    username, password = email.get('smtp_username') or sender, email.get('smtp_password')
    if not email_address(recipient) or not email_address(sender):
        raise SetupError('请配置有效的 sender 和 recipient 邮箱。')
    if not isinstance(host, str) or not re.fullmatch(r'[A-Za-z0-9.-]+', host) or type(port) is not int or not 1 <= port <= 65535:
        raise SetupError('请配置有效的 smtp_host 和 smtp_port。')
    if security not in ('ssl', 'starttls'):
        raise SetupError('smtp_security 必须为 ssl 或 starttls。')
    if not isinstance(username, str) or not isinstance(password, str) or not password:
        raise SetupError('请配置 SMTP 登录凭据。')
    return dict(enabled=enabled, recipient=recipient, sender=sender, smtp_password=password,
                smtp_username=username, smtp_host=host, smtp_port=port, smtp_security=security,
                access_password=access.get('password') or '',
                password_updated_at=access.get('password_updated_at'),
                url=email.get('access_url') or access.get('url') or access.get('local_url') or '')


def clean(value, limit=512):
    return re.sub(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]', ' ', str(value or '未知'))[:limit]


def visitor_ip(value):
    try:
        return str(ipaddress.ip_address(clean(value, 64)))
    except ValueError:
        return '未知'


def read_recent_visits():
    try:
        with (STATE / HISTORY_NAME).open() as source:
            data = json.loads(source.read(65537))
        if data.get('version') != 1 or not isinstance(data.get('visits'), list):
            return None
        return data['visits'][:HISTORY_LIMIT]
    except FileNotFoundError:
        return []
    except (OSError, ValueError, AttributeError):
        return None


def identity_fields(row):
    kind = row.get('loginType')
    label = LOGIN_LABELS.get(kind, '未记录') if isinstance(kind, str) else '未记录'
    def field(key):
        value = row.get(key)
        if kind in ('shared', 'admin'):
            return '未绑定'
        return clean(value, 120) if kind == 'department' and isinstance(value, str) and value.strip() else '未记录'
    username = row.get('username')
    organization = row.get('organization')
    return {'用户名': clean(username, 60) if isinstance(username, str) and username.strip() else '未记录',
            '机构（填写）': clean(organization, 160) if isinstance(organization, str) and organization.strip() else '未记录',
            '登录方式': label, '公司': field('company'), '部门': field('department')}


def recent_lines(visits):
    if visits is None:
        return ['最近成功登录：记录暂不可读，请检查服务器运行目录。']
    records = [row for row in visits if isinstance(row, dict)][:HISTORY_LIMIT] if isinstance(visits, list) else []
    lines = [f'最近 {HISTORY_LIMIT} 次成功登录（最新在前，当前 {len(records)} 条）：', '时间为北京时间（UTC+8）。']
    for index, row in enumerate(records, 1):
        identity = identity_fields(row)
        lines.extend(['', f'{index:02d}. {identity["用户名"]} · {identity["登录方式"]}',
            '    时间：' + layout.display_time(row.get('time')),
            '    机构（填写）：' + identity['机构（填写）'],
            '    公司：' + identity['公司'], '    部门：' + identity['部门'],
            '    IP：' + visitor_ip(row.get('ip')),
            '    浏览器：' + clean(row.get('browser'), 80), '    系统：' + clean(row.get('os'), 64)])
    return lines if records else lines + ['暂无记录；从启用此功能后开始累计。']


def recent_html(visits):
    if visits is None:
        body = layout.paragraph('记录暂不可读，请检查服务器运行目录。')
        count = '记录暂不可读'
    else:
        records = [row for row in visits if isinstance(row, dict)][:HISTORY_LIMIT] if isinstance(visits, list) else []
        count = f'当前 {len(records)} 条'
        cards = []
        for index, row in enumerate(records, 1):
            identity = identity_fields(row)
            cards.append(layout.visit_card(index, identity['用户名'], identity['登录方式'], [
                ('时间', layout.display_time(row.get('time'))), ('机构（填写）', identity['机构（填写）']),
                ('公司 / 部门', identity['公司'] + ' / ' + identity['部门']),
                ('设备', clean(row.get('browser'), 80) + ' · ' + clean(row.get('os'), 64)),
                ('IP', visitor_ip(row.get('ip')))]))
        body = ''.join(cards) or layout.paragraph('暂无记录；从启用此功能后开始累计。')
    return layout.section(f'最近 {HISTORY_LIMIT} 次成功登录', body, '最新在前 · ' + count + ' · 北京时间（UTC+8）')


def message(config, event, test=False):
    changed = not test and isinstance(event, dict) and event.get('type') == 'password_changed'
    if test:
        title, intro = '发信测试', '这是一封 API Docs 发信测试邮件。'
        rows = [('发送时间', layout.display_time(utc_now()))]
        note = '自动通知在用户成功登录或管理员修改访问码时触发。'
        visits = read_recent_visits()
    elif changed:
        title, intro = '访问码已变更', '管理员已修改 API Docs 访问码。'
        rows = [('变更时间', layout.display_time(event.get('time'))),
                ('访问码更新时间', layout.display_time(config.get('password_updated_at')))]
        note = '访问码在管理员下次修改前持续有效，重启服务不会改变。'
        visits = read_recent_visits()
    else:
        if not isinstance(event, dict):
            raise ValueError('Invalid visit')
        title, intro = '新登录通知', '有访客成功登录 API Docs。'
        visits = event.get('recentVisits', [event])
        rows = [('登录时间', layout.display_time(event.get('time'))), *identity_fields(event).items(),
                ('IP', visitor_ip(event.get('ip'))), ('IP 来源', clean(event.get('ipSource'), 64)),
                ('浏览器', clean(event.get('browser'), 80)), ('操作系统', clean(event.get('os'), 64))]
        note = ''
    text = '\n'.join([intro, '', *[label + '：' + value for label, value in rows]])
    body = layout.section('本次登录' if not test and not changed else '通知详情', layout.details(rows) + (layout.paragraph(note, True) if note else ''))
    if note:
        text += '\n' + note
    # Only use the administrator-configured origin, never request URLs or parameters.
    url = layout.origin(config['url'])
    if url:
        text += '\n\n文档入口：' + url
    # Only the current server configuration supplies this password. It never
    # enters the login-event queue, history file, status output or HTTP response.
    password = config['access_password'] or '尚未生成，请先启动文档服务。'
    text += '\n当前访问密码：' + password
    access_note = '当前全权限访问码，取自发送时的配置。'
    if changed:
        access_note = '以上为发送时的当前访问码；连续修改时，以最新配置为准。'
        text += '\n' + access_note
    body += layout.section('文档访问', layout.entry(url) + layout.details([('当前访问密码', password)]) + layout.paragraph(access_note, True))
    text += '\n\n' + '\n'.join(recent_lines(visits))
    body += recent_html(visits)
    if not test and not changed:
        agent = clean(event.get('userAgent'))
        text += '\n\n客户端详情\nUser-Agent：' + agent
        body += layout.section('客户端详情', layout.details([('User-Agent', agent)]))
    footer = '同一会话刷新不重复记录；机构由访客填写，公司和部门为登录时配置的密码归属。时间显示为北京时间（UTC+8），服务器保留原始记录。'
    text += '\n\n' + footer
    mail = EmailMessage()
    mail['Subject'] = 'API Docs · ' + title
    mail['From'], mail['To'] = config['sender'], config['recipient']
    mail['Date'] = format_datetime(datetime.now(timezone.utc))
    mail['Message-ID'] = make_msgid(domain=config['sender'].rsplit('@', 1)[-1])
    mail['Auto-Submitted'] = 'auto-generated'
    mail.set_content(text)
    mail.add_alternative(layout.document(title, intro, body, footer), subtype='html')
    return mail


def deliver(config, mail):
    context = ssl.create_default_context()
    if config['smtp_security'] == 'ssl':
        smtp = smtplib.SMTP_SSL(config['smtp_host'], config['smtp_port'], timeout=config.get('smtp_timeout', 8), context=context)
    else:
        smtp = smtplib.SMTP(config['smtp_host'], config['smtp_port'], timeout=config.get('smtp_timeout', 8))
        try:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        except BaseException:
            smtp.close()
            raise
    try:
        smtp.login(config['smtp_username'], config['smtp_password'])
        refused = smtp.send_message(mail, from_addr=config['sender'], to_addrs=[config['recipient']])
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
        # A QUIT failure after DATA was accepted must not turn success into a retry.
        try:
            smtp.quit()
        except (OSError, smtplib.SMTPException):
            pass
    finally:
        smtp.close()


def record_status(status, event_type='login'):
    file = STATE / STATUS_NAME
    previous = {}
    try:
        previous = json.loads(file.read_text())
    except (FileNotFoundError, ValueError):
        pass
    result = {'status': status, 'event_type': event_type, 'updated_at': utc_now(), 'last_accepted_at': previous.get('last_accepted_at')}
    if status == 'accepted':
        result['last_accepted_at'] = result['updated_at']
    atomic_write(file, json.dumps(result) + '\n')
    return result


def send_event(event=None, test=False):
    event_type = 'test' if test else 'password_changed' if isinstance(event, dict) and event.get('type') == 'password_changed' else 'login'
    with mail_lock():
        try:
            docs = read_config()['api_docs']
            if docs['email']['enabled'] is False and not test:
                return record_status('disabled', event_type)
            config = settings(docs)
            deliver(config, message(config, event, test))
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
        return record_status(result, event_type)


def status():
    try:
        config = settings()
    except SetupError as error:
        print(str(error)); return 3
    print('收件邮箱：已配置（' + str(config_file('email')) + ' 的 recipient）')
    print('发信方式：SMTP / TLS，验证服务器证书')
    print('发件账号与授权码：已配置，不显示凭据')
    print('自动登录、改密及留言通知：' + ('已开启' if config['enabled'] else '已关闭'))
    file = STATE / STATUS_NAME
    if file.exists():
        result = json.loads(file.read_text())
        print('最近通知类型：' + EVENT_LABELS.get(result.get('event_type', 'login'), '未知'))
        print('最近发送结果：' + LABELS.get(result.get('status'), '未知') + ' / ' + str(result.get('updated_at', '')))
    print('本地配置检查完成；实际发信检查请运行 python3 scripts/visit_email.py test。')
    return 0


def main():
    parser = argparse.ArgumentParser(description='SMTP 登录与改密通知管理；凭据不回显。')
    parser.add_argument('command', choices=['status', 'test', 'send', 'history'])
    args, extra = parser.parse_known_args()
    if extra:
        parser.exit(2, '不接受命令行邮箱凭据，请编辑私有 email.yaml。\n')
    if args.command == 'history':
        visits = read_recent_visits()
        print('\n'.join(recent_lines(visits)))
        return 3 if visits is None else 0
    if args.command == 'status':
        return status()
    # A login carries ten bounded history rows, including names and organizations.
    raw = sys.stdin.read(65537) if args.command == 'send' else ''
    if len(raw) > 65536:
        raise ValueError('Oversized event')
    result = send_event(json.loads(raw) if raw else None, test=args.command == 'test')
    if args.command == 'send':
        print(json.dumps(result)); return 0
    print(LABELS[result['status']] + ('，请检查收件箱及垃圾邮件。' if result['status'] == 'accepted' else '；请运行 python3 scripts/visit_email.py status 检查。'))
    return 0 if result['status'] == 'accepted' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print('\n操作已取消。', file=sys.stderr); sys.exit(1)
    except SetupError as error:
        print(str(error), file=sys.stderr); sys.exit(3)
    except Exception:
        # SMTP errors and YAML source can contain credentials: never echo them.
        print('邮件操作失败，请检查配置、网络及邮箱服务；凭据未输出。', file=sys.stderr); sys.exit(1)
