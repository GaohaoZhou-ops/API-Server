import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {ROOT, STATE, CONFIG, PYTHON} from './runtime.mjs';
import {createVisitHistory, loginIdentity, HISTORY_LIMIT} from './visit-history.mjs';

const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 512);
const ip = value => {
  const text = String(value || '').replace(/^::ffff:/, '');
  return net.isIP(text) ? text : '';
};

export function visitorInfo(req, now = new Date()) {
  const peer = ip(req.socket.remoteAddress);
  // The production listener is loopback-only, behind our local cloudflared.
  // Never accept visitor-supplied forwarding headers on a direct public socket.
  const forwarded = (peer === '::1' || peer.startsWith('127.')) && ip(req.headers['cf-connecting-ip']);
  const ua = clean(req.headers['user-agent']);
  const browser = [['Edge', /(?:Edg|EdgA|EdgiOS)\/([\d.]+)/], ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Opera', /OPR\/([\d.]+)/], ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/]]
    .map(([name, pattern]) => { const match = ua.match(pattern); return match && `${name} ${match[1]}`; }).find(Boolean) || '未知';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS / iPadOS' :
    /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '未知';
  return {time: now.toISOString(), ip: forwarded || peer || '未知',
    ipSource: forwarded ? 'Cloudflare 本机隧道' : '直接连接', browser, os, userAgent: ua || '未提供'};
}

export function createVisitNotifier({config = CONFIG, state = STATE, python = PYTHON,
    run = execFile, warn = message => console.error(message), timeout = 25000, maxPending = 64} = {}) {
  const pending = [];
  const passwordChanges = [];
  let active = null, closed = false, busy = false;
  const lastWarning = new Map();
  const history = createVisitHistory({state, warn: report});
  function report(status) {
    if (Date.now() - (lastWarning.get(status) || 0) < 60000) return;
    lastWarning.set(status, Date.now());
    if (status.startsWith('history_')) {
      warn(`访问记录读写失败（${status}）；历史列表可能不完整。`);
      return;
    }
    // No child output, visitor data or credentials are copied into logs.
    warn(`管理员邮件通知未发送（${status}）；请运行 python3 scripts/visit_email.py status 检查。`);
  }
  function next() {
    if (closed || busy || (!pending.length && !passwordChanges.length)) return;
    busy = true;
    const event = passwordChanges.shift() || pending.shift();
    try {
      active = run(python, [path.join(ROOT, 'scripts/visit_email.py'), 'send'], {
        env: {...process.env, API_DOCS_CONFIG: config, API_DOCS_STATE: state},
        timeout, killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8'
      }, (error, stdout) => {
        active = null; busy = false;
        if (closed) return;
        let status = 'worker_failed';
        try {
          const result = JSON.parse(stdout);
          if (['accepted', 'disabled', 'not_configured', 'auth_failed', 'recipient_rejected', 'tls_failed', 'failed'].includes(result.status)) status = result.status;
        } catch {}
        if (error) status = 'worker_failed';
        if (!['accepted', 'disabled'].includes(status)) report(status);
        next();
      });
      active.stdin.on('error', () => {});
      active.stdin.end(JSON.stringify(event));
    } catch {
      active = null; busy = false; report('worker_failed');
      setImmediate(next);
    }
  }
  return {
    recentVisits() { return {limit: HISTORY_LIMIT, visits: history.list()}; },
    visitsPage(options) { return history.page(options); },
    refreshVisits(cleared = false) {
      history.invalidate();
      if (cleared) for (const event of pending) event.recentVisits = [];
    },
    notify(req, {sendEmail = true, identity} = {}) {
      if (closed) return;
      // Name and organization are visitor input; role, company and department come from server policy.
      const event = {...visitorInfo(req), ...loginIdentity(identity)};
      event.recentVisits = history.append(event);
      // Administrator logins remain in history without entering the mail queue.
      if (!sendEmail) return;
      if (pending.length >= maxPending) { report('queue_full'); return; }
      pending.push(event); next();
    },
    passwordChanged(time) {
      if (closed) return;
      // Only the private administrator channel can enqueue these; a full visitor
      // queue cannot drop or delay them behind its waiting login notifications.
      passwordChanges.push({type: 'password_changed', time}); next();
    },
    close() { closed = true; pending.length = 0; passwordChanges.length = 0; active?.kill('SIGKILL'); }
  };
}
