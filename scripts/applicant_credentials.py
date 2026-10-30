"""Read active individual credential digests without exposing delivery secrets."""
import sqlite3
from runtime import STATE


def records():
    file = STATE / 'access-requests.sqlite3'
    if not file.exists():
        return []
    if file.is_symlink():
        raise ValueError('Unsafe credential storage')
    with sqlite3.connect(file.resolve().as_uri()+'?mode=ro', uri=True, timeout=5) as db:
        db.row_factory = sqlite3.Row
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version in (0, 1, 2):
            return []
        if version not in (3, 4):
            raise ValueError('Unsupported credential storage')
        return [dict(row) for row in db.execute('SELECT id,company,department,password_hash FROM applicant_credentials')]


def scopes(departments, full_passwords):
    import hashlib
    from permissions import versions
    allowed = {(r['company'], r['department']): r for r in departments}
    forbidden = {hashlib.sha256(p.encode()).hexdigest() for p in full_passwords if isinstance(p,str)}
    result = []
    for record in records():
        rule = allowed.get((record['company'], record['department']))
        if rule and record['password_hash'] not in forbidden:
            result.append({**record, **{key: versions(rule.get(key, [])) for key in ('api_versions',)}})
    return result
