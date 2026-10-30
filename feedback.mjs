import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {ROOT, STATE, CONFIG, PYTHON} from './runtime.mjs';

const fail = (status, message) => Object.assign(new Error(message), {status});
export const FEEDBACK_BODY_LIMIT = 21 * 1024 * 1024;
export function createFeedback({state = STATE, config = CONFIG, python = PYTHON, run = execFile,
    warn = message => console.error(message), interval = 15000} = {}) {
  const salt = crypto.randomBytes(32);
  let closed = false, worker = null, timer, active = false, submissions = 0;
  function call(command, input, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const child = run(python, [path.join(ROOT, 'scripts/feedback.py'), command], {
        env: {...process.env, API_DOCS_STATE: state, API_DOCS_CONFIG: config}, timeout,
        killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8'
      }, (error, stdout) => {
        if (error) { reject(fail(503, '留言服务暂不可用，请稍后重试。')); return; }
        try { resolve(JSON.parse(stdout)); }
        catch { reject(fail(503, '留言服务暂不可用，请稍后重试。')); }
      });
      if (command === 'send-next') worker = child;
      child.stdin.on('error', () => {});
      child.stdin.end(input ? JSON.stringify(input) : '');
    });
  }
  async function drain() {
    if (closed || active) return;
    active = true;
    try {
      const result = await call('send-next', null, 120000);
      if (result.processed && !closed) setImmediate(drain);
      if (result.status === 'failed') warn('留言邮件发送失败，记录已保留；可通过 feedback.sh 查看和重试。');
    } catch { if (!closed) warn('留言邮件队列暂不可用；记录保留在服务器。'); }
    finally { active = false; worker = null; }
  }
  timer = setInterval(drain, interval); timer.unref();
  setImmediate(drain);
  return {
    beginSubmission() {
      if (closed || submissions >= 2) throw fail(503, '留言上传繁忙，请稍后重试。');
      submissions++;
      return () => { submissions--; };
    },
    async submit(data, ip, version) {
      if (closed) throw fail(503, '服务正在重启，请稍后重试。');
      const result = await call('submit', {submission_id: data.submission_id, name: data.name, email: data.email,
        organization: data.organization, category: data.category, message: data.message, document_version: version,
        attachments: data.attachments,
        rate_key: crypto.createHmac('sha256', salt).update(ip).digest('hex')});
      if (result.ok !== true) throw fail([400, 409, 413, 429].includes(result.status) ? result.status : 503,
        result.error || '留言未保存，请稍后重试。');
      drain();
      return {id: result.id, created_at: result.created_at};
    },
    close() { closed = true; clearInterval(timer); worker?.kill('SIGKILL'); }
  };
}
