import path from 'node:path';
import {execFile} from 'node:child_process';
import {ROOT, STATE, CONFIG, PYTHON} from './runtime.mjs';

const fail = (status, message) => Object.assign(new Error(message), {status});
export function createAccessRequests({state = STATE, config = CONFIG, python = PYTHON, run = execFile,
    warn = message => console.error(message), interval = 15000} = {}) {
  let closed = false, active = false;
  const children = new Set(), attempts = new Map();
  function call(command, input, timeout = 10000) {
    if (closed || children.size >= 4) return Promise.reject(fail(503, '申请服务繁忙，请稍后重试。'));
    return new Promise((resolve, reject) => {
      const child = run(python, [path.join(ROOT, 'scripts/access_requests.py'), command], {
        env: {...process.env, API_DOCS_STATE: state, API_DOCS_CONFIG: config, API_DOCS_NODE: process.execPath}, timeout,
        killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8'
      }, (error, stdout) => {
        children.delete(child);
        if (error) { reject(fail(503, '申请服务暂不可用，请稍后重试。')); return; }
        try {
          const {ok, status, error: message, ...result} = JSON.parse(stdout);
          if (ok !== true) { reject(fail([400, 401, 404, 409, 413, 429].includes(status) ? status : 503, message || '申请服务暂不可用。')); return; }
          resolve(command === 'send-next' ? {...result, status} : result);
        } catch { reject(fail(503, '申请服务暂不可用，请稍后重试。')); }
      });
      children.add(child);
      child.stdin.on('error', () => {});
      child.stdin.end(input ? JSON.stringify(input) : '');
    });
  }
  async function drain() {
    if (closed || active || children.size >= 4) return;
    active = true;
    try {
      const result = await call('send-next', null, 35000);
      if (result.processed && !closed) setImmediate(drain);
      if (result.status === 'failed') warn('访问申请邮件发送失败；记录已保留，可在管理员面板重试。');
    } catch { if (!closed) warn('访问申请邮件队列暂不可用；申请记录保留在服务器。'); }
    finally { active = false; }
  }
  const timer = setInterval(drain, interval); timer.unref(); setImmediate(drain);
  return {
    drain,
    throttle(ip) {
      // Cheap request limits precede JSON parsing and child process creation.
      const now = Date.now(), cutoff = now - 600000;
      for (const [key, values] of attempts) {
        const recent = values.filter(time => time > cutoff);
        if (recent.length) attempts.set(key, recent); else attempts.delete(key);
      }
      for (const [key, limit] of [['global', 120], ['ip:' + ip, 20]]) {
        if ((attempts.get(key)?.length || 0) >= limit) throw fail(429, '申请过于频繁，请稍后再试。');
      }
      for (const key of ['global', 'ip:' + ip]) attempts.set(key, [...(attempts.get(key) || []), now]);
    },
    async submit(data, ip) {
      const result = await call('submit', {submission_id: data.submission_id, name: data.name,
        email: data.email, organization: data.organization, ip});
      drain(); return result;
    },
    page(data) { return call('page', data); },
    async retry(id, signature) {
      const result = await call('retry', {id, admin_signature: signature}); drain(); return result;
    },
    close() { closed = true; clearInterval(timer); attempts.clear(); for (const child of children) child.kill('SIGKILL'); }
  };
}
