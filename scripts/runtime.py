#!/usr/bin/env python3
"""Linux process locks and atomic access-config updates for the docs service."""
import ctypes
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.request import urlopen

import yaml

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get('API_DOCS_STATE', str(Path(__file__).resolve().parents[1] / 'var/state')))
CONFIG = Path(os.environ.get('API_DOCS_CONFIG', str(ROOT / 'var/config')))
CONFIG_GROUPS = ('access', 'email', 'runtime')
GROUP_HEADERS = {
    'access': '''# 私有访问配置，权限 600；请勿提交到 Git 或发送给访客。
# url 可直接打开，可由管理员配置；local_url 是实际监听地址的记录。
# password 为全版本阅读码，无管理权限；可用管理员面板或 python3 scripts/change_password.py 修改。
# admin_password 是独立管理凭据，可直接编辑，留空禁用；管理员登录不发登录邮件。
# 所有密码须彼此不同；用户访问码长期有效，重启不换码。
# password_updated_at 为 UTC；地址、普通访问码和时间戳由服务维护。
''',
    'email': '''# 私有邮件配置，权限 600；保存后下次通知生效，无需重启。
# enabled 控制登录、改密、留言、申请及授权邮件；recipient 是管理员收件邮箱。
# sender / recipient 为发件与收件邮箱；smtp_host、smtp_port、smtp_security 配置服务。
# smtp_username / smtp_password 是 SMTP 登录凭据；smtp_security 为 ssl 或 starttls。
# 登录、改密和测试邮件含普通访问码；留言邮件不含密码。
# access_url 可指定通知和授权邮件中的固定文档入口，省略时使用当前服务地址。
''',
    'runtime': '''# 自动维护的运行状态，请勿手动修改；时间为 UTC，权限 600。
# 这里的状态和 PID 不作为服务启动参数。
''',
    'extra': '# 迁移保留的其他配置和自定义字段，权限 600；请勿提交到 Git。\n',
}
FIELD_PATHS = {
    'url': ('access', 'url'), 'local_url': ('access', 'local_url'),
    'password': ('access', 'password'), 'password_updated_at': ('access', 'password_updated_at'),
    'server_pid': ('runtime', 'server', 'pid'), 'server_status': ('runtime', 'server', 'status'),
    'tunnel_pid': ('runtime', 'tunnel', 'pid'), 'tunnel_status': ('runtime', 'tunnel', 'status'),
}
LEGACY_PATHS = {**FIELD_PATHS, 'updated_at': ('runtime', 'updated_at'),
    'visit_email_enabled': ('email', 'enabled'), 'send_email': ('email', 'sender'),
    'smtp_password': ('email', 'smtp_password')}
CONFIG_HEADER = '''# 私有配置，权限 600；请勿提交到 Git 或发送给访客。
# access：服务维护入口与普通访问码；admin_password 由管理员填写。
# 普通访问码请用 scripts/change_password.py 修改；admin_password 保存后生效，留空禁用。
# 访问密码长期有效，重启不换密；仅首次缺少密码时生成。
# email：管理员可编辑；下一次登录、改密或留言通知时生效，SMTP 使用 TLS。
# runtime：服务自动维护的进程状态，请勿手动修改；时间均为 UTC。
'''


def lock_file(file, nonblocking=False):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
    except BaseException:
        os.close(fd)
        raise
    return fd


def normalize_config(data):
    """Read legacy fields without rewriting; explicit nested values take priority."""
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValueError('Configuration must be a mapping')
    data = deepcopy(data)
    docs = data.setdefault('api_docs', {})
    if not isinstance(docs, dict):
        raise ValueError('api_docs must be a mapping')
    version = docs.get('config_version', 1)
    if type(version) is not int or version not in (1, 2):
        raise ValueError('Unsupported configuration version')
    for path in [('access',), ('email',), ('runtime',), ('runtime', 'server'), ('runtime', 'tunnel')]:
        group = docs
        for key in path:
            group = group.setdefault(key, {})
            if not isinstance(group, dict):
                raise ValueError('Configuration groups must be mappings')
    # Device binding was retired in service 1.14.0. Drop all former layouts.
    for group in (data, docs, docs['access']):
        group.pop('authed_devices', None)
    for old, path in LEGACY_PATHS.items():
        if old in docs:
            group = docs
            for key in path[:-1]:
                group = group[key]
            group.setdefault(path[-1], docs.pop(old))
    email = docs['email']
    if 'recipient' not in email:
        email['recipient'] = docs.get('receive_email') or docs.get('admin_email') or data.get('admin_email') or ''
    for key in ('receive_email', 'admin_email'):
        docs.pop(key, None)
    email.setdefault('enabled', False)
    email.setdefault('sender', '')
    email.setdefault('smtp_password', '')
    # Keep the file's main groups and their fields in a predictable reading order.
    def ordered(group, keys):
        return {**{key: group[key] for key in keys if key in group}, **group}
    docs['access'] = ordered(docs['access'], ('url', 'local_url', 'password', 'password_updated_at', 'admin_password'))
    docs['email'] = ordered(email, ('enabled', 'recipient', 'sender', 'smtp_host', 'smtp_port', 'smtp_security', 'smtp_username', 'smtp_password'))
    for key in ('server', 'tunnel'):
        docs['runtime'][key] = ordered(docs['runtime'][key], ('status', 'pid'))
    docs['runtime'] = ordered(docs['runtime'], ('updated_at', 'server', 'tunnel'))
    docs['config_version'] = 2
    data['api_docs'] = ordered(docs, ('config_version', 'access', 'email', 'runtime'))
    return data


def config_location():
    """Old resident workers may still pass the former default filename."""
    path = Path(os.path.abspath(CONFIG))
    return path


def directory_config(path):
    return path.is_dir() or path.suffix.lower() not in ('.yaml', '.yml')


def config_file(group):
    path = config_location()
    return path / (group + '.yaml') if directory_config(path) else path


def config_lock(path):
    if directory_config(path):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.chmod(0o700)
        return path / '.config.lock'
    return path.with_name('.' + path.name + '.lock')


def atomic_text(path, text):
    temporary = None
    try:
        handle, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
        with os.fdopen(handle, 'w') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        # Persist directory entries as well as the file contents.
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def recover_split(path):
    """Roll back an interrupted multi-file update before any reader proceeds."""
    journal = path / '.pending.json'
    if not journal.exists():
        return
    previous = json.loads(journal.read_text())
    allowed = {group + '.yaml' for group in (*CONFIG_GROUPS, 'extra')} | {'.initialized', 'permissions.yaml'}
    if not isinstance(previous, dict) or set(previous) - allowed or any(
            value is not None and not isinstance(value, str) for value in previous.values()):
        raise ValueError('Invalid configuration transaction')
    for name, value in previous.items():
        if value is None:
            (path / name).unlink(missing_ok=True)
        else:
            atomic_text(path / name, value)
    journal.unlink()


def read_split(path):
    marker = path / '.initialized'
    if marker.exists() and marker.read_text().strip() != '1':
        raise ValueError('Unsupported configuration directory version')
    names = [path / (group + '.yaml') for group in CONFIG_GROUPS]
    if not any(file.exists() for file in names) and not marker.exists() and not (path / 'extra.yaml').exists():
        return None
    if not all(file.is_file() for file in names):
        raise ValueError('Incomplete configuration directory; restore the missing file')
    extra = path / 'extra.yaml'
    data = yaml.safe_load(extra.read_text()) if extra.exists() else {}
    if not isinstance(data, dict) or not isinstance(data.get('api_docs', {}), dict):
        raise ValueError('Extra configuration must be a mapping')
    docs = data.setdefault('api_docs', {})
    if set(CONFIG_GROUPS) & docs.keys():
        raise ValueError('Configuration groups must be stored in their own files')
    for group, file in zip(CONFIG_GROUPS, names):
        value = yaml.safe_load(file.read_text())
        if not isinstance(value, dict):
            raise ValueError('Configuration groups must be mappings')
        docs[group] = value
    return normalize_config(data)


def read_unlocked(path):
    if not directory_config(path):
        return normalize_config(yaml.safe_load(path.read_text()) if path.exists() else {})
    recover_split(path)
    data = read_split(path)
    return data if data is not None else normalize_config({})


def read_config():
    path = config_location()
    fd = lock_file(config_lock(path))
    try:
        return read_unlocked(path)
    finally:
        os.close(fd)


def save_split(path, data):
    values = {group: data['api_docs'][group] for group in CONFIG_GROUPS}
    extra = deepcopy(data)
    for key in (*CONFIG_GROUPS, 'config_version'):
        extra['api_docs'].pop(key, None)
    if not extra['api_docs']:
        extra.pop('api_docs')
    if extra or (path / 'extra.yaml').exists():
        values['extra'] = extra
    changes = {}
    for group, value in values.items():
        file = path / (group + '.yaml')
        # Status updates do not rewrite the administrator's mail settings/comments.
        if file.exists() and yaml.safe_load(file.read_text()) == value:
            file.chmod(0o600)
            continue
        changes[file.name] = GROUP_HEADERS[group] + yaml.safe_dump(value, allow_unicode=True, sort_keys=False)
    if not (path / '.initialized').exists():
        changes['.initialized'] = '1\n'
    if not changes:
        return
    journal = path / '.pending.json'
    previous = {name: (path / name).read_text() if (path / name).exists() else None for name in changes}
    atomic_text(journal, json.dumps(previous, ensure_ascii=False))
    try:
        for name, text in changes.items():
            atomic_text(path / name, text)
        journal.unlink()
    except BaseException:
        recover_split(path)
        raise


def runtime_fields(data=None):
    """The existing Node IPC and control.sh aliases keep their flat field names."""
    docs = (read_config() if data is None else data)['api_docs']
    result = {}
    for field, path in FIELD_PATHS.items():
        group = docs
        for key in path[:-1]:
            group = group[key]
        if path[-1] in group:
            result[field] = group[path[-1]]
    return result


def edit_config(change):
    """Serialize readers/writers; preserve credentials through the directory move."""
    path = config_location()
    fd = lock_file(config_lock(path))
    try:
        data = read_unlocked(path)
        if change(data) is False:
            return False
        data = normalize_config(data)
        if directory_config(path):
            save_split(path, data)
        else:
            atomic_text(path, CONFIG_HEADER + yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
        return True
    finally:
        os.close(fd)


def update_config(patch, owner=None):
    if set(patch) - FIELD_PATHS.keys() or set(owner or {}) - FIELD_PATHS.keys():
        raise ValueError('Unknown runtime configuration field')
    def change(data):
        current = runtime_fields(data)
        if owner and any(current.get(key) != value for key, value in owner.items()):
            return False
        for field, value in patch.items():
            group = data['api_docs']
            path = FIELD_PATHS[field]
            for key in path[:-1]:
                group = group[key]
            group[path[-1]] = value
        data['api_docs']['runtime']['updated_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    return edit_config(change)


def migrate_config():
    # A schema migration does not rotate credentials or change process timestamps.
    return edit_config(lambda data: None)


def ready(access):
    if (access.get('server_status') != 'running' or access.get('tunnel_status') != 'running'
            or not access.get('url') or not access.get('password')):
        return False
    try:
        for field in ('server_pid', 'tunnel_pid'):
            os.kill(int(access[field]), 0)
        with urlopen(access['local_url'] + '/healthz', timeout=1) as response:
            health = json.load(response)
        return health.get('ok') is True and health.get('pid') == access['server_pid']
    except (OSError, KeyError, ValueError):
        return False


def main():
    action = sys.argv[1]
    if action == 'lock':
        role = sys.argv[2]
        if role not in ('web', 'admin-panel'):
            raise ValueError('Unknown service role')
        fd = lock_file(STATE / (role + '.lock'), nonblocking=True)
        print('locked', flush=True)
        # EOF also releases the kernel lock when the Node owner is SIGKILLed.
        sys.stdin.buffer.read()
        os.close(fd)
    elif action == 'child':
        # cloudflared must not survive an unexpected death of its Node parent.
        parent = int(sys.argv[2])
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise OSError('Cannot set child parent-death signal')
        if os.getppid() != parent:
            return 1
        fd = lock_file(STATE / 'cloudflared.lock', nonblocking=True)
        os.set_inheritable(fd, True)
        os.execv(sys.argv[3], sys.argv[3:])
    elif action == 'supervised':
        # If our private Supervisor dies, terminate its services as well.
        parent = os.getppid()
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
            raise OSError('Cannot set service parent-death signal')
        if parent <= 1 or os.getppid() != parent:
            return 1
        os.execv(sys.argv[2], sys.argv[2:])
    elif action == 'update':
        message = json.load(sys.stdin)
        update_config(message['patch'], message.get('owner'))
    elif action == 'get':
        value = runtime_fields().get(sys.argv[2])
        if value is None:
            return 3
        print(value)
    elif action == 'access-password':
        access = read_config()['api_docs']['access']
        print(json.dumps({key: access.get(key) for key in ('password', 'password_updated_at')}))
    elif action == 'admin-password':
        from permissions import load_policy
        access = read_config()['api_docs']['access']
        password = access.get('admin_password')
        # An ordinary shared code can never acquire management rights by collision.
        try:
            policy = load_policy(config_file('access').parent / 'permissions.yaml')
            department_passwords = [rule.get('password') for company in policy.get('companies', {}).values()
                                    for rule in company.get('departments', {}).values()]
        except Exception:
            # Broken department policies already fail closed. Keep the independent
            # administrator credential available for documentation and diagnostics.
            department_passwords = []
        print(json.dumps({'password': password if password != access.get('password')
                          and password not in department_passwords else None}))
    elif action == 'migrate':
        migrate_config()
        print('配置已整理：' + str(config_location()) + '；保留已有密码、邮件设置及自定义字段。')
    elif action == 'stopped':
        if config_file('access').exists():
            update_config({'url': None, 'server_pid': None, 'tunnel_pid': None,
                           'server_status': 'stopped', 'tunnel_status': 'stopped'})
    elif action in ('wait-ready', 'status'):
        deadline = time.monotonic() + (float(os.environ.get('API_DOCS_START_TIMEOUT', '90')) if action == 'wait-ready' else 0)
        while True:
            access = runtime_fields()
            if ready(access):
                print('访问地址：' + access['url'])
                print('密码文件：' + str(config_file('access')))
                return 0
            if time.monotonic() >= deadline:
                print('文档/隧道尚未就绪；请运行 control.sh status 或 logs。', file=sys.stderr)
                print('配置位置：' + str(config_location()), file=sys.stderr)
                return 1
            time.sleep(0.3)
    else:
        raise ValueError('Unknown runtime command')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BlockingIOError:
        print('服务已有实例运行（进程锁被占用）。', file=sys.stderr)
        sys.exit(73)
    except Exception as error:
        # YAML parse errors can include the credential: never echo their source.
        print('运行配置操作失败：' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
