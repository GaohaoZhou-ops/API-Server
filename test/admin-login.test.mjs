import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createAdminLogin} from '../admin-login.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function temporary(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-login-'));
  t.after(() => fs.rmSync(state, {recursive: true, force: true}));
  return state;
}

test('admin credential changes revoke existing and in-flight authentication, while unrelated edits preserve sessions', async t => {
  const state = temporary(t), config = path.join(state, 'config.yaml'), warnings = [];
  const write = (password, note = '') => fs.writeFileSync(config, JSON.stringify({api_docs: {access: {admin_password: password}}, note}));
  const auth = createAdminLogin({config, warn: message => warnings.push(message)});
  write('Admin-QA'); // Configured values need not match the ordinary code's 16-character minimum.
  assert.equal(await auth.verify('incorrect'), null);
  const original = await auth.verify('Admin-QA'); assert.ok(original);
  write('Admin-QA', 'changed'); assert.equal(auth.active(original), true);
  const pending = auth.verify('Admin-QA'); write('中文Admin2');
  assert.equal(await pending, null); assert.equal(auth.active(original), false);
  assert.equal(await auth.verify('Admin-QA'), null);
  assert.ok(await auth.verify('中文Admin2'));
  for (const invalid of [undefined, null, '', 1234, [], {}, 'bad\nvalue', 'x'.repeat(1025)]) {
    write(invalid);
    assert.equal(await auth.verify('中文Admin2'), null);
    assert.equal(await auth.verify(''), null);
  }
  write('Admin-QA'); const restored = await auth.verify('Admin-QA');
  assert.ok(restored); assert.notEqual(restored, original); assert.equal(auth.active(original), false);
  fs.writeFileSync(config, 'api_docs: [PRIVATE-BROKEN');
  assert.equal(auth.active(restored), false); assert.equal(await auth.verify('Admin-QA'), null);
  fs.rmSync(config); assert.equal(await auth.verify('Admin-QA'), null);
  assert.ok(warnings.length > 0); assert.doesNotMatch(warnings.join('\n'), /Admin-QA|中文Admin2|PRIVATE-BROKEN/);
});

test('editing access.yaml in place also revokes the old administrator session', async t => {
  const config = path.join(temporary(t), 'config'); fs.mkdirSync(config);
  const access = path.join(config, 'access.yaml');
  fs.writeFileSync(access, JSON.stringify({admin_password: 'Admin-Before'}));
  for (const name of ['email', 'runtime']) fs.writeFileSync(path.join(config, name + '.yaml'), '{}');
  const auth = createAdminLogin({config});
  const before = await auth.verify('Admin-Before'); assert.ok(before);
  // An editor may write the existing inode instead of renaming a new file.
  const inode = fs.statSync(access).ino;
  fs.writeFileSync(access, JSON.stringify({admin_password: 'Admin-After'}));
  assert.equal(fs.statSync(access).ino, inode);
  assert.equal(auth.active(before), false); assert.equal(await auth.verify('Admin-Before'), null);
  assert.ok(await auth.verify('Admin-After'));
});
