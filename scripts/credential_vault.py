"""Authenticated encryption for explicit administrator password viewing."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import subprocess


def transform(db, record, value, action):
    database = Path(db.execute('PRAGMA database_list').fetchone()['file'])
    binding = json.dumps(['applicant-password-v1', *[record[key] for key in
                         ('id', 'request_sequence', 'company', 'department', 'password_hash')]], ensure_ascii=False)
    create_key = not db.execute('SELECT 1 FROM applicant_credentials WHERE password_encrypted IS NOT NULL LIMIT 1').fetchone()
    node = os.environ.get('API_DOCS_NODE') or shutil.which('node') or 'node'
    result = subprocess.run([node, str(Path(__file__).with_suffix('.mjs'))],
        input=json.dumps({'action': action, 'value': value, 'binding': binding,
                          'key_file': str(database.parent / 'applicant-password.key'), 'create_key': create_key}),
        capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise ValueError('Credential vault unavailable')
    return json.loads(result.stdout)['value']


def seal(db, record, password):
    if not hmac.compare_digest(record['password_hash'], hashlib.sha256(password.encode()).hexdigest()):
        raise ValueError('Credential mismatch')
    return transform(db, record, password, 'seal')


def reveal(db, record):
    password = transform(db, record, record['password_encrypted'], 'open')
    if not hmac.compare_digest(record['password_hash'], hashlib.sha256(password.encode()).hexdigest()):
        raise ValueError('Credential mismatch')
    return password


def preserve_queued(db):
    # V3 already delivered passwords have only a digest and cannot be recovered.
    for row in db.execute('''SELECT c.*, g.delivery_password FROM applicant_credentials c
            JOIN request_grants g ON g.credential_id=c.id AND g.request_sequence=c.request_sequence
            WHERE c.password_encrypted IS NULL AND g.delivery_password IS NOT NULL''').fetchall():
        db.execute('UPDATE applicant_credentials SET password_encrypted=? WHERE id=?',
                   (seal(db, row, row['delivery_password']), row['id']))
