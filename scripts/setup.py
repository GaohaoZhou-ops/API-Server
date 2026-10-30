"""Initialize only this installation's private settings; repeated runs keep passwords."""
import json
import os
import secrets
import sys
from runtime import STATE, config_file, edit_config, read_config

def main():
    if sys.argv[1] == 'credentials':
        access = read_config()['api_docs']['access']
        print(json.dumps({key: access.get(key) for key in ('password', 'admin_password')}, ensure_ascii=False, indent=2))
        return
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    def change(data):
        access = data['api_docs']['access']
        access.setdefault('password', secrets.token_urlsafe(24))
        access.setdefault('admin_password', secrets.token_urlsafe(24))
        access.setdefault('url', '')
        email = data['api_docs']['email']
        for key, value in {'enabled': False, 'smtp_host': '', 'smtp_port': 465, 'smtp_security': 'ssl',
                           'smtp_username': '', 'smtp_password': '', 'access_url': ''}.items():
            email.setdefault(key, value)
    edit_config(change)
    file = config_file('access').parent / 'permissions.yaml'
    try:
        fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w') as output:
            output.write('companies: {}\n')
    print('Private configuration initialized; email is disabled until configured.')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Setup failed; check private configuration and permissions.', file=sys.stderr)
        sys.exit(1)
