import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT, CONFIG, PYTHON, STATE} from './runtime.mjs';

const stamp = file => {
  try { const s = fs.statSync(file, {bigint: true}); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
};
const isDirectory = config => !/\.ya?ml$/i.test(config) || (fs.existsSync(config) && fs.statSync(config).isDirectory());

// Policy credentials exist only in the server. References held in sessions are
// replaced whenever that department's password or allowed versions change.
export function createVersionPermissions({config = CONFIG, python = PYTHON, applicants = false, state = STATE,
    file = path.join(isDirectory(config) ? config : path.dirname(config), 'permissions.yaml'),
    warn = message => console.error(message)} = {}) {
  const pepper = crypto.randomBytes(32);
  const digest = value => crypto.createHmac('sha256', pepper).update(value).digest('hex');
  let fingerprint, entries = new Map(), references = new Map(), lastWarning = 0;
  function policy() {
    let key;
    try {
      key = stamp(file) + ':' + stamp(isDirectory(config) ? path.join(config, 'access.yaml') : config);
      if (applicants) key += ':' + stamp(path.join(state, 'access-requests.sqlite3'));
      if (fingerprint === key) return;
      const result = spawnSync(python, [path.join(ROOT, 'scripts/permissions.py'), '--file', file, '--json', ...(applicants ? ['--applicants'] : [])],
        {encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: {...process.env, API_DOCS_CONFIG: config, API_DOCS_STATE: state}});
      if (result.error || result.status !== 0) throw new Error();
      const next = new Map(), refs = new Map();
      for (const record of JSON.parse(result.stdout)) {
        const {password, password_hash, ...scope} = record;
        const signature = digest(JSON.stringify(record));
        const key = digest(password_hash ? 'sha256:' + password_hash : password), previous = entries.get(key);
        const entry = previous?.signature === signature ? previous : {...scope, signature, reference: crypto.randomUUID()};
        next.set(key, entry); refs.set(entry.reference, entry);
      }
      entries = next; references = refs; fingerprint = key;
    } catch {
      entries = new Map(); references = new Map(); fingerprint = key;
      if (Date.now() - lastWarning >= 60000) {
        lastWarning = Date.now(); warn('部门权限配置不可用；已拒绝部门访问，请在服务器检查 permissions.yaml。');
      }
    }
  }
  return {
    initialize() {
      try { fs.writeFileSync(file, fs.readFileSync(path.join(ROOT, 'config/permissions.yaml.example')), {flag: 'wx', mode: 0o600}); }
      catch (error) { if (error.code !== 'EEXIST') throw new Error('无法初始化部门权限配置'); }
    },
    verify(value) {
      if (typeof value !== 'string' || value.length > 1024) return null;
      policy(); return (entries.get(digest(value)) || entries.get(digest('sha256:' + crypto.createHash('sha256').update(value).digest('hex'))))?.reference || null;
    },
    active(reference) { policy(); return references.has(reference); },
    scope(reference) { policy(); return references.get(reference) || null; }
  };
}

export function visibleVersions(versions, scope) {
  if (!scope) return versions;
  const allowed = versions.versions.filter(version => scope.api_versions.includes(version.id));
  return {current: allowed.some(version => version.id === versions.current) ? versions.current : allowed.at(-1)?.id || null,
    versions: allowed};
}
