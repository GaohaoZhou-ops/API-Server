import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {STATE, ROOT, PYTHON} from './runtime.mjs';
import {validateUsername, validateOrganization} from './web/login-name.mjs';

export const HISTORY_NAME = 'recent-visits.json';
export const HISTORY_DATABASE = 'visit-history.sqlite3';
export const HISTORY_LIMIT = 10;
const clean = (value, limit) => String(value || '未知').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, limit);
export function loginIdentity(value = {}) {
  const loginType = ['department', 'shared', 'admin'].includes(value?.loginType) ? value.loginType : 'unknown';
  const name = field => loginType === 'department' && typeof value[field] === 'string'
    ? [...value[field].replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')].slice(0, 120).join('') : '';
  return {username: validateUsername(value?.username) || '', organization: validateOrganization(value?.organization) || '',
    loginType, company: name('company'), department: name('department')};
}
function record(value) {
  if (!value || typeof value.time !== 'string' || !Number.isFinite(Date.parse(value.time))) return null;
  return {time: new Date(value.time).toISOString(), ip: typeof value.ip === 'string' && net.isIP(value.ip) ? value.ip : '未知',
    browser: clean(value.browser, 80), os: clean(value.os, 64), ...loginIdentity(value)};
}

// The singleton web process is the only writer. Keep history independent of SMTP
// success and queue capacity, and pass each email the snapshot for its own login.
export function createVisitHistory({state = STATE, warn = () => {}} = {}) {
  const file = path.join(state, HISTORY_NAME);
  let visits;
  function query(command, data = {}) {
    const result = spawnSync(PYTHON, [path.join(ROOT, 'scripts/visit_history.py'), command], {
      input: JSON.stringify({legacy: visits || [], ...data}), encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
      env: {...process.env, API_DOCS_STATE: state}
    });
    if (result.error || result.status !== 0) throw new Error('History unavailable');
    const response = JSON.parse(result.stdout);
    response.visits = response.visits.map(record).filter(Boolean);
    return response;
  }
  function load() {
    if (visits) return visits;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > 65536) throw new Error();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.visits)) throw new Error();
      visits = saved.visits.map(record).filter(Boolean).slice(0, HISTORY_LIMIT);
    } catch (error) {
      if (error.code !== 'ENOENT') warn('history_read_failed');
      visits = [];
    }
    // The database is authoritative after migration; the JSON file remains the mail/CLI cache.
    if (fs.existsSync(path.join(state, HISTORY_DATABASE))) {
      try { visits = query('page').visits; }
      catch { warn('history_read_failed'); }
    }
    return visits;
  }
  return {
    list() { return load().map(visit => ({...visit})); },
    invalidate() { visits = undefined; },
    page({page = 1, snapshot = null} = {}) {
      if (!Number.isSafeInteger(page) || page < 1 || (snapshot !== null && (!Number.isSafeInteger(snapshot) || snapshot < 0)))
        throw Object.assign(new Error('访问记录分页参数无效'), {status: 400});
      load();
      try { return query('page', {page, snapshot}); }
      catch {
        warn('history_read_failed');
        throw Object.assign(new Error('访问记录暂不可读，请稍后重试。'), {status: 503});
      }
    },
    append(event) {
      const current = record(event);
      if (!current) return [...load()];
      load();
      try { visits = query('append', {visit: current}).visits; }
      catch {
        // Login and email remain available on a storage failure; never replace a damaged database.
        warn('history_write_failed');
        visits = [current, ...visits].slice(0, HISTORY_LIMIT);
      }
      const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      let fd;
      try {
        fs.mkdirSync(state, {recursive: true, mode: 0o700});
        fs.chmodSync(state, 0o700);
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({version: 1, visits}) + '\n');
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, file);
      } catch {
        warn('history_write_failed');
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
        try { fs.rmSync(temporary, {force: true}); } catch {}
      }
      return [...visits];
    }
  };
}
