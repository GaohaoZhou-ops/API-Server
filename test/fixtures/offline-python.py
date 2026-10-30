#!/usr/bin/env python3
"""Test-only Python entry point. No SMTP socket is opened."""
import json
import os
from pathlib import Path
import runpy
import smtplib
import sys

class OfflineSMTP:
    def __init__(self, *args, **kwargs):
        pass
    def login(self, *args):
        pass
    def ehlo(self):
        pass
    def starttls(self, **kwargs):
        pass
    def send_message(self, mail, **kwargs):
        root = Path(os.environ['API_DOCS_STATE'])
        root.mkdir(parents=True, exist_ok=True)
        with (root / 'test-mail.jsonl').open('a') as output:
            output.write(json.dumps({'to': str(mail['To']), 'subject': str(mail['Subject']),
                                     'types': [part.get_content_type() for part in mail.walk()]}) + '\n')
        return {}
    def quit(self):
        pass
    def close(self):
        pass

smtplib.SMTP = smtplib.SMTP_SSL = OfflineSMTP
script = sys.argv.pop(1)
sys.path.insert(0, str(Path(script).resolve().parent))
sys.argv[0] = script
runpy.run_path(script, run_name='__main__')
