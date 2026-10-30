import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {spawnSync} from 'node:child_process';
import {CONFIG, PYTHON, HELPER} from './runtime.mjs';

const scrypt = promisify(crypto.scrypt);
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n\0]/.test(value);

// The administrator credential retains access to all published versions.
// Policy checks also revoke existing admin sessions when this field changes.
export function createAdminLogin({config = CONFIG, python = PYTHON, helper = HELPER,
    warn = message => console.error(message)} = {}) {
  let fingerprint, current = null, lastWarning = 0;
  function report() {
    if (Date.now() - lastWarning < 60000) return;
    lastWarning = Date.now();
    warn('管理员凭据不可用；请检查 access.yaml、permissions.yaml 及密码是否重复，凭据未输出。');
  }
  function policy() {
    try {
      const access = fs.statSync(config).isDirectory() ? path.join(config, 'access.yaml') : config;
      const info = fs.statSync(access, {bigint: true});
      let policyStamp = 'missing';
      try { const p = fs.statSync(path.join(path.dirname(access), 'permissions.yaml'), {bigint: true}); policyStamp = `${p.ino}:${p.size}:${p.mtimeNs}:${p.ctimeNs}`; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const key = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${policyStamp}`;
      if (fingerprint === key) return current;
      const result = spawnSync(python, [helper, 'admin-password'], {encoding: 'utf8', timeout: 5000, maxBuffer: 32768,
        env: {...process.env, API_DOCS_CONFIG: config}});
      if (result.error || result.status !== 0) throw new Error();
      const {password} = JSON.parse(result.stdout);
      if (!valid(password)) {
        current = null;
        if (password !== null && password !== undefined && password !== '') report();
      } else {
        const signature = crypto.createHash('sha256').update(password).digest('hex');
        if (current?.signature !== signature) {
          const salt = crypto.randomBytes(16);
          current = {signature, reference: crypto.randomUUID(), salt,
            hash: scrypt(password, salt, 64).catch(() => {report(); return null;})};
        }
      }
      fingerprint = key;
      return current;
    } catch {
      // A broken/missing configuration must never fall back to a cached credential.
      current = null; fingerprint = undefined; report(); return null;
    }
  }
  return {
    active(reference) { return !!reference && policy()?.reference === reference; },
    signature(reference) { const saved = policy(); return reference && saved?.reference === reference ? saved.signature : null; },
    async verify(value) {
      if (!valid(value)) return null;
      const saved = policy();
      if (!saved) return null;
      try {
        const [candidate, expected] = await Promise.all([scrypt(value, saved.salt, 64), saved.hash]);
        return expected && crypto.timingSafeEqual(candidate, expected) && policy() === saved ? saved.reference : null;
      } catch { report(); return null; }
    }
  };
}
