#!/usr/bin/env python3
"""Administrator-only password changes via the local private Unix socket."""
import argparse
import getpass
import json
import os
import socket
import stat
import sys

from runtime import STATE, config_file, config_location, lock_file, read_config


def main():
    parser = argparse.ArgumentParser(description='在服务器上修改文档访问密码；不重启服务或改变网址。')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--generate', action='store_true', help='自动生成随机密码并写入 config/access.yaml，不打印密码')
    modes.add_argument('--stdin', action='store_true', help='从标准输入读取一行新密码，用于管理脚本')
    args, extra = parser.parse_known_args()
    if extra:
        parser.exit(2, '不接受命令行密码参数；请使用交互输入、--stdin 或 --generate。\n')
    password = None
    if not args.generate:
        if args.stdin:
            password = sys.stdin.read(4097)
            if password.endswith('\r\n'):
                password = password[:-2]
            elif password.endswith('\n'):
                password = password[:-1]
        else:
            if not sys.stdin.isatty():
                parser.exit(2, '请在交互终端运行，或指定 --stdin / --generate。\n')
            password = getpass.getpass('新访问密码（16–128 个字符，输入不回显）：')
            if password != getpass.getpass('再次输入新密码：'):
                parser.exit(2, '两次输入不一致，密码未修改。\n')
        if not 16 <= len(password) <= 128 or any(c in password for c in '\r\n\0'):
            parser.exit(2, '密码须为 16 至 128 个字符，不能包含换行或空字符。\n')
    if not STATE.is_dir():
        parser.exit(3, '文档服务未运行，请先执行 control.sh start。\n')
    # Share the lifecycle lock so stop/restart cannot race a successful change.
    fd = lock_file(STATE / 'control.lock')
    try:
        server = read_config()['api_docs']['runtime']['server']
        if server.get('status') != 'running' or not server.get('pid'):
            parser.exit(3, '文档服务未运行，请先执行 control.sh start。\n')
        endpoint = STATE / 'admin.sock'
        info = endpoint.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_mode & 0o777 != 0o600:
            parser.exit(1, '本地管理通道类型或权限不正确，密码未修改。\n')
        message = {'command': 'change-password', 'mode': 'generate' if args.generate else 'set',
                   'pid': server['pid'], 'config': str(config_location())}
        if password is not None:
            message['password'] = password
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(15)
            client.connect(str(endpoint))
            client.sendall((json.dumps(message, ensure_ascii=False) + '\n').encode())
            response = b''
            while not response.endswith(b'\n') and len(response) < 8192:
                chunk = client.recv(4096)
                if not chunk:
                    break
                response += chunk
        result = json.loads(response)
        if result.get('ok') is not True:
            parser.exit(1, '修改失败，未收到服务成功确认；请检查服务状态与配置。\n')
    finally:
        os.close(fd)
    if result.get('changed') is False:
        print('访问密码未变化，现有会话保留；不重复发送邮件。')
    else:
        print('访问密码已更新，旧登录会话已失效；服务和访问地址保持不变。')
        print('管理员改密通知已排队；发送结果可用 ./visit-email.sh status 查看。')
    print('密码文件：' + str(config_file('access')) + '（password / password_updated_at）')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print('\n操作已取消。', file=sys.stderr)
        sys.exit(1)
    except (ConnectionError, FileNotFoundError):
        print('本地管理通道不可用，请确认服务正在运行且支持管理员改密。', file=sys.stderr)
        sys.exit(3)
    except Exception:
        # Parse errors can contain credentials; never print exception contents.
        print('未能确认密码更新，请检查服务状态及访问配置；不要直接编辑运行中的密码。', file=sys.stderr)
        sys.exit(1)
