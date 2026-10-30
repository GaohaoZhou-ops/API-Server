#!/usr/bin/env python3
"""Private visitor history. JSON IPC is used only by the web process."""
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys

from runtime import atomic_text

STATE = Path(os.environ.get('API_DOCS_STATE', str(Path(__file__).resolve().parents[1] / 'var/state')))
DATABASE_NAME = 'visit-history.sqlite3'
PAGE_SIZE = 10
FIELDS = ('time', 'ip', 'browser', 'os', 'username', 'organization', 'loginType', 'company', 'department')


def record(value):
    if isinstance(value, dict):
        value = {'organization': '', **value}
    if not isinstance(value, dict) or any(not isinstance(value.get(key), str) for key in FIELDS):
        raise ValueError('Invalid visit')
    # Values are normalized by the shared Node history layer. Store only its public metadata.
    result = {key: value[key] for key in FIELDS}
    if any(len(value) > 240 for value in result.values()):
        raise ValueError('Oversized visit')
    return json.dumps(result, ensure_ascii=False, separators=(',', ':'))


def connect(legacy):
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE, 0o700)
    file = STATE / DATABASE_NAME
    fd = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Invalid history storage')
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    db = sqlite3.connect(file, timeout=2)
    try:
        db.execute('BEGIN IMMEDIATE')
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0, 1):
            raise ValueError('Unsupported history database')
        if version == 0:
            db.execute('CREATE TABLE visits (id INTEGER PRIMARY KEY, record TEXT NOT NULL)')
            # The marker and oldest-first imports commit together, once, even after a restart.
            if not isinstance(legacy, list) or len(legacy) > PAGE_SIZE:
                raise ValueError('Invalid legacy history')
            db.executemany('INSERT INTO visits(record) VALUES (?)', [(record(row),) for row in reversed(legacy)])
            db.execute('PRAGMA user_version = 1')
        db.commit()
        return db
    except Exception:
        db.close()
        raise


def page(db, number=1, snapshot=None):
    if type(number) is not int or number < 1 or number > 9007199254740991:
        raise ValueError('Invalid page')
    if snapshot is not None and (type(snapshot) is not int or snapshot < 0 or snapshot > 9007199254740991):
        raise ValueError('Invalid snapshot')
    newest = db.execute('SELECT COALESCE(MAX(id),0) FROM visits').fetchone()[0]
    snapshot = newest if snapshot is None else min(snapshot, newest)
    total = db.execute('SELECT COUNT(*) FROM visits WHERE id<=?', (snapshot,)).fetchone()[0]
    pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    number = min(number, pages)
    rows = db.execute('SELECT record FROM visits WHERE id<=? ORDER BY id DESC LIMIT ? OFFSET ?',
                      (snapshot, PAGE_SIZE, (number - 1) * PAGE_SIZE)).fetchall()
    return {'limit': PAGE_SIZE, 'page': number, 'pages': pages, 'total': total, 'snapshot': snapshot,
            'visits': [json.loads(row[0]) for row in rows]}


def clear():
    """Called only by admin_panel after password verification under its config lock."""
    db = connect([])
    try:
        db.execute('BEGIN IMMEDIATE')
        count = db.execute('SELECT COUNT(*) FROM visits').fetchone()[0]
        db.execute('DELETE FROM visits')
        # Empty the mail/CLI cache before committing. On failure the database rolls
        # back; it remains authoritative and can repopulate the cache on next login.
        atomic_text(STATE / 'recent-visits.json', json.dumps({'version': 1, 'visits': []}) + '\n')
        db.commit()
        return count
    finally:
        db.close()


def main():
    os.umask(0o077)
    command = sys.argv[1]
    if command not in ('append', 'page'):
        raise ValueError('Invalid command')
    raw = sys.stdin.read(65537)
    if len(raw) > 65536:
        raise ValueError('Oversized input')
    value = json.loads(raw)
    current = record(value['visit']) if command == 'append' else None
    db = connect(value.get('legacy', []))
    try:
        # One transaction gives every read and queued email a consistent snapshot.
        db.execute('BEGIN IMMEDIATE' if command == 'append' else 'BEGIN')
        if current is not None:
            db.execute('INSERT INTO visits(record) VALUES (?)', (current,))
        result = page(db, value.get('page', 1), value.get('snapshot'))
        db.commit()
        print(json.dumps(result, ensure_ascii=False))
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not echo request metadata, filesystem paths or database contents.
        print('Visit history storage unavailable', file=sys.stderr)
        sys.exit(1)
