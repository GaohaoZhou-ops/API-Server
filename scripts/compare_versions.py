"""Bounded text comparison for validated public contracts."""
import difflib
import json
import resource
import sys

MAX_LINES = 5000

def line_diff(before, after):
    old = before.splitlines() if before is not None else []
    new = after.splitlines() if after is not None else []
    if max(len(old), len(new)) > MAX_LINES:
        return None
    rows = []
    for tag, i, j, k, l in difflib.SequenceMatcher(None, old, new, autojunk=True).get_opcodes():
        if tag == 'equal':
            rows.extend({'kind': 'equal', 'old': i + n + 1, 'new': k + n + 1, 'text': value}
                        for n, value in enumerate(old[i:j]))
        else:
            rows.extend({'kind': 'remove', 'old': n + 1, 'new': None, 'text': old[n]} for n in range(i, j))
            rows.extend({'kind': 'add', 'old': None, 'new': n + 1, 'text': new[n]} for n in range(k, l))
    return rows


def main():
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    raw = sys.stdin.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('Input limit')
    data = json.loads(raw)
    if data.get('action') != 'diff':
        raise ValueError('Unsupported operation')
    values = [data.get(key) for key in ('before', 'after')]
    if any(value is not None and (not isinstance(value, str) or len(value) > 256 * 1024) for value in values):
        raise ValueError('Text limit')
    print(json.dumps({'lines': line_diff(*values)}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 422, 'error': '内容超过在线对比限制'}))
