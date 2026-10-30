import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

test('MIME layout, screenshots and TLS SMTP pass isolated Python regression checks', t => {
  const root = fileURLToPath(new URL('..', import.meta.url)), state = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-mail-'));
  t.after(() => fs.rmSync(state, {recursive: true, force: true}));
  execFileSync(process.env.API_DOCS_PYTHON || '/usr/bin/python3', ['-m', 'unittest', 'discover', '-s', 'test/python'], {
    cwd: root, timeout: 15000, env: {...process.env, PYTHONPATH: path.join(root, 'scripts'), API_DOCS_STATE: state, API_DOCS_CONFIG: path.join(state, 'config')}, stdio: ['ignore', 'pipe', 'pipe']
  });
});
