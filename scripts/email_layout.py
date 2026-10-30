"""Shared, self-contained HTML for administrator notifications (no remote assets)."""
from datetime import datetime, timedelta, timezone
from html import escape
import re
from urllib.parse import urlsplit, urlunsplit

BEIJING = timezone(timedelta(hours=8))
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif"
WRAP = 'word-break:break-all;overflow-wrap:anywhere;'


def text(value):
    return escape(str(value if value is not None else ''), quote=True)


def display_time(value):
    raw = re.sub(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]', ' ', str(value or ''))[:64]
    if not raw:
        return '未记录'
    try:
        stamp = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if stamp.tzinfo is not None:
            return stamp.astimezone(BEIJING).strftime('%Y-%m-%d %H:%M:%S') + '（UTC+8）'
    except (ValueError, OverflowError):
        pass
    return raw + '（原始记录，时区未确认）'


def origin(value):
    """Use configured HTTP(S) origins only; drop paths, queries and fragments."""
    if not isinstance(value, str) or re.search(r'[\s<>"\\\x00-\x1f\x7f]', value):
        return ''
    try:
        url = urlsplit(value)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            return ''
        url.port  # Validate malformed/out-of-range ports before creating a link.
        return urlunsplit((url.scheme, url.netloc, '/', '', ''))
    except ValueError:
        return ''


def paragraph(value, muted=False):
    color = '#647267' if muted else '#25332e'
    lines = text(value).replace('\r\n', '\n').replace('\r', '\n').replace('\n', '<br>')
    return f'<p style="margin:8px 0;font-size:14px;line-height:1.8;color:{color};white-space:pre-wrap;{WRAP}">{lines}</p>'


def details(rows):
    cells = []
    for label, value in rows:
        cells.append('<tr><th scope="row" width="90" valign="top" '
            'style="width:90px;text-align:left;padding:5px 12px 5px 0;font-size:12px;line-height:1.8;font-weight:400;color:#647267;">'
            + text(label) + '</th><td valign="top" style="padding:5px 0;font-size:14px;line-height:1.7;color:#25332e;white-space:pre-wrap;'
            + WRAP + '">' + text(value) + '</td></tr>')
    return '<table width="100%" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:collapse;">' + ''.join(cells) + '</table>'


def section(title, content, subtitle=''):
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="width:100%;table-layout:fixed;border:1px solid #dfe7dc;border-radius:10px;background:#ffffff;"><tr><td style="padding:20px;">'
            '<h2 style="margin:0 0 12px;font-size:17px;line-height:1.6;color:#294b38;">' + text(title) + '</h2>'
            + (paragraph(subtitle, True) if subtitle else '') + content + '</td></tr></table>'
            '<div style="height:14px;line-height:14px;font-size:1px;">&nbsp;</div>')


def visit_card(index, name, login_type, rows):
    return ('<table class="visit-record" role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="width:100%;table-layout:fixed;border-top:1px solid #e1e9dd;"><tr><td style="padding:16px 0 12px;">'
            '<h3 style="margin:0 0 3px;font-size:15px;line-height:1.7;color:#25332e;' + WRAP + '">'
            f'<span style="color:#55764b;">{index:02d}</span> &nbsp;{text(name)}</h3>'
            '<p style="margin:0 0 8px;font-size:12px;line-height:1.7;color:#52734c;">' + text(login_type) + '</p>'
            + details(rows) + '</td></tr></table>')


def entry(url, label='打开文档站', admin=False):
    base = origin(url)
    if not base:
        return ''
    target = base + ('#admin' if admin else '')
    return ('<table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0 8px;"><tr>'
            '<td bgcolor="#216747" style="background:#216747;border-radius:6px;padding:12px 18px;">'
            '<a href="' + text(target) + '" style="color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">'
            + text(label) + '</a></td></tr></table>' + paragraph(urlsplit(base).netloc, True))


def document(title, intro, body, footer):
    # Fixed-width fallback for Word-based Outlook; other clients use the fluid table.
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="color-scheme" content="light"><title>' + text(title) + '</title></head>'
            '<body style="margin:0;padding:0;background:#f4f7f1;color:#25332e;font-family:' + FONT + ';">'
            '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">' + text(intro) + '</div>'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f7f1" '
            'style="width:100%;background:#f4f7f1;"><tr><td align="center" style="padding:24px 12px;">'
            '<!--[if mso]><table role="presentation" width="680" align="center"><tr><td><![endif]-->'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'style="width:100%;max-width:680px;table-layout:fixed;font-family:' + FONT + ';">'
            '<tr><td bgcolor="#173f2d" style="background:#173f2d;padding:26px 24px;border-radius:12px 12px 0 0;">'
            '<p style="margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#cee2c8;">API DOCS · 管理通知</p>'
            '<h1 style="margin:0;font-size:24px;line-height:1.5;color:#ffffff;">' + text(title) + '</h1>'
            '<p style="margin:12px 0 0;font-size:14px;line-height:1.8;color:#d8e8d4;">' + text(intro) + '</p>'
            '</td></tr><tr><td style="padding-top:18px;">' + body + '</td></tr>'
            '<tr><td style="padding:0 12px 18px;">' + paragraph(footer, True) + '</td></tr></table>'
            '<!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>')
