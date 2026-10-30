import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {STATE, CONFIG, singleton, updateConfig, readAccessPassword} from './runtime.mjs';
import {startPasswordAdmin, validPassword} from './password-admin.mjs';
import {createAdminLogin} from './admin-login.mjs';
import {createAdminPanel} from './admin-panel.mjs';
import {createVisitNotifier, visitorInfo} from './visit-notifier.mjs';
import {COOKIE_AGE, cookieValue, appendCookie} from './session-cookies.mjs';
import {publicDocs, publicOpenAPI, emptyDocs} from './public-docs.mjs';
import {readRegistry, readPublication} from './publications.mjs';
import {createVersionPermissions, visibleVersions} from './version-permissions.mjs';
import {createVersionComparison} from './version-comparison.mjs';
import {createFeedback, FEEDBACK_BODY_LIMIT} from './feedback.mjs';
import {createAccessRequests} from './access-requests.mjs';
import {validateUsername, USERNAME_ERROR, validateOrganization, ORGANIZATION_ERROR} from './web/login-name.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(process.env.API_DOCS_CONTENT_ROOT || path.join(ROOT, 'var/content'));
const PORT = Number(process.env.API_DOCS_PORT || 8787);
const HOST = process.env.API_DOCS_HOST || '127.0.0.1';
const scrypt = promisify(crypto.scrypt);
try { await singleton('web'); }
catch (error) { console.error(error.message); process.exit(error.exitCode || 1); }
let auth;
let passwordUpdatedAt = null;
let passwordAdmin;
const visitNotifier = createVisitNotifier();
const adminLogin = createAdminLogin();
const departmentLogin = createVersionPermissions({applicants: true});
const versionComparison = createVersionComparison({contentRoot: CONTENT});
const feedback = createFeedback();
const accessRequests = createAccessRequests();
const adminPanel = createAdminPanel({contentRoot: CONTENT});
let mutations = Promise.resolve();
function serializeMutation(task) {
  const result = mutations.then(task);
  mutations = result.catch(() => {});
  return result;
}
let stopping = false;
async function setPassword(password, startup = {}) {
  const previous = auth;
  const unchanged = previous && await matches(password);
  if (stopping) throw new Error('服务正在停止');
  if (unchanged) return {changed: false, password_updated_at: passwordUpdatedAt};
  const salt = crypto.randomBytes(16).toString('hex');
  const next = {salt, hash: (await scrypt(password, salt, 64)).toString('hex')};
  if (stopping) throw new Error('服务正在停止');
  const updatedAt = new Date().toISOString();
  updateConfig({...startup, password, password_updated_at: updatedAt});
  auth = next;
  passwordUpdatedAt = updatedAt;
  sessions.clear(); attempts.clear();
  // Notify only after both persistence and live authentication have succeeded.
  // Initial generation has no previous code to change and sends no change notice.
  if (previous) visitNotifier.passwordChanged(updatedAt);
  return {changed: true, password_updated_at: updatedAt};
}
async function initializePassword(startup) {
  const saved = readAccessPassword();
  if (saved.password === null || saved.password === undefined || saved.password === '') {
    await setPassword(crypto.randomBytes(24).toString('base64url'), startup);
    return;
  }
  if (!validPassword(saved.password)) throw new Error('已保存的访问密码格式无效；未自动更换密码。');
  const salt = crypto.randomBytes(16).toString('hex');
  const next = {salt, hash: (await scrypt(saved.password, salt, 64)).toString('hex')};
  if (stopping) throw new Error('服务正在停止');
  updateConfig(startup);
  auth = next;
  passwordUpdatedAt = saved.password_updated_at ?? null;
}
const sessions = new Map();
const attempts = new Map();
const recordClearAttempts = new Map();
const fail = (status, message) => Object.assign(new Error(message), {status});
const secure = req => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '不接受跨站请求');
  if (req.headers.origin && req.headers.origin !== `${secure(req) ? 'https' : 'http'}://${req.headers.host}`) throw fail(403, '来源校验失败');
}
function sessionFor(req) {
  const token = cookieValue(req, 'api_docs_session');
  const s = token && sessions.get(token);
  if (!s || (s.admin && !adminLogin.active(s.admin)) || (s.department && !departmentLogin.active(s.department))) {
    if (token) sessions.delete(token); return null;
  }
  return {...s, token};
}
function cookie(req, res, token, age) {
  appendCookie(res, `api_docs_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure(req) ? '; Secure' : ''}`);
}
function createSession(req, res, username, organization, admin = null, department = null) {
  const scope = department ? departmentLogin.scope(department) : null;
  if (department && !scope) throw fail(401, '权限已变更，请重新登录');
  const previous = sessionFor(req);
  if (previous) sessions.delete(previous.token);
  const token = crypto.randomBytes(32).toString('hex');
  const session = {csrf: crypto.randomBytes(24).toString('hex'), username, organization, admin, department};
  sessions.set(token, session); cookie(req, res, token, COOKIE_AGE);
  if (!previous || previous.username !== username || previous.organization !== organization || previous.admin !== admin || previous.department !== department) {
    visitNotifier.notify(req, {sendEmail: !admin, identity: {
      username, organization, loginType: admin ? 'admin' : department ? 'department' : 'shared',
      company: scope?.company, department: scope?.department
    }});
  }
  return {...session, token};
}
function json(res, status, data) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); }
async function body(req, maximum = 16384) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, '请求必须使用 JSON');
  if (Number(req.headers['content-length']) > maximum) throw fail(413, '请求过大');
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > maximum) throw fail(413, '请求过大'); chunks.push(chunk); }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw fail(400, 'JSON 格式错误'); }
}
async function matches(value) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const current = auth;
  return crypto.timingSafeEqual(await scrypt(value, current.salt, 64), Buffer.from(current.hash, 'hex'));
}
function throttle(req) {
  const now = Date.now(); const ip = visitorInfo(req).ip;
  for (const key of [ip, '*']) {
    const recent = (attempts.get(key) || []).filter(t => t > now - 600000);
    if (recent.length >= (key === '*' ? 60 : 8)) throw fail(429, '登录尝试过多，请 10 分钟后再试');
    recent.push(now); attempts.set(key, recent);
  }
}
function throttleRecordClear(req) {
  const now = Date.now(), ip = visitorInfo(req).ip;
  for (const key of [ip, '*']) {
    const recent = (recordClearAttempts.get(key) || []).filter(time => time > now - 600000);
    if (recent.length >= (key === '*' ? 60 : 8)) throw fail(429, '清理验证过于频繁，请 10 分钟后再试。');
    recent.push(now); recordClearAttempts.set(key, recent);
  }
}
function content(name) { if (name !== 'versions.json') throw new Error('Unknown publication'); return readRegistry(CONTENT); }
function revision(url, scope, allowEmpty = false) {
  const versions = visibleVersions(content('versions.json'), scope);
  const id = url.searchParams.get('version') || versions.current;
  if (allowEmpty && !id) return {id: null, versions};
  if (!id || (scope && !versions.versions.some(v => v.id === id))) throw fail(403, '当前访问密码未获授权此 API 文档版本');
  if (!versions.versions.some(v => v.id === id) || !/^[a-zA-Z0-9.-]+$/.test(id)) throw fail(404, '文档版本不存在');
  return {id, versions, read: () => readPublication(CONTENT, id)};
}
const files = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/login-name.mjs', ['web/login-name.mjs', 'text/javascript; charset=utf-8']],
  ['/feedback.mjs', ['web/feedback.mjs', 'text/javascript; charset=utf-8']],
  ['/access-request.mjs', ['web/access-request.mjs', 'text/javascript; charset=utf-8']],
  ['/admin.mjs', ['web/admin.mjs', 'text/javascript; charset=utf-8']],
  ['/compare.mjs', ['web/compare.mjs', 'text/javascript; charset=utf-8']],
  ['/openapi.mjs', ['web/openapi.mjs', 'text/javascript; charset=utf-8']],
  ['/markdown.mjs', ['web/markdown.mjs', 'text/javascript; charset=utf-8']],
  ['/diagrams.mjs', ['web/diagrams.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/dagre.mjs', ['web/vendor/dagre.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/markdown-it.mjs', ['web/vendor/markdown-it.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/highlight.mjs', ['web/vendor/highlight.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['web/style.css', 'text/css; charset=utf-8']],
  ['/theme.css', ['web/theme.css', 'text/css; charset=utf-8']],
  ['/theme.js', ['web/theme.js', 'text/javascript; charset=utf-8']],
  ['/fonts/noto-sans-sc.woff2', ['public/fonts/noto-sans-sc.woff2', 'font/woff2']],
  ['/fonts/OFL.txt', ['public/fonts/OFL.txt', 'text/plain; charset=utf-8']]
]);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (secure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // Retire cookies left by older releases; they can no longer authenticate.
  if ((req.headers.cookie || '').split(';').some(value => value.trim().startsWith('api_docs_device='))) {
    appendCookie(res, `api_docs_device=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req) ? '; Secure' : ''}`);
  }
  try {
    if (!auth || stopping) throw fail(503, '文档服务正在启动或停止');
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    if (['/api/password', '/api/source', '/api/snapshot', '/api/manifest.json', '/api/device-bind'].includes(route)) throw fail(404, '接口不存在');
    if ((req.method === 'GET' || req.method === 'HEAD') && files.has(route)) {
      const [file, type] = files.get(route); const bytes = fs.readFileSync(path.join(ROOT, file));
      if (route.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=2592000');
      res.writeHead(200, {'Content-Type': type, 'Content-Length': bytes.length});
      res.end(req.method === 'HEAD' ? undefined : bytes); return;
    }
    if (route === '/healthz' && req.method === 'GET') return json(res, 200, {ok: true, service: 'project-api-docs', pid: process.pid});
    if (!route.startsWith('/api/')) throw fail(404, '页面不存在');
    checkOrigin(req);
    if (route === '/api/access-requests' && req.method === 'POST') {
      const ip = visitorInfo(req).ip;
      accessRequests.throttle(ip);
      return json(res, 201, await accessRequests.submit(await body(req), ip));
    }
    if (route === '/api/login' && req.method === 'POST') {
      throttle(req); const data = await body(req);
      const username = validateUsername(data.username);
      if (!username) throw fail(400, USERNAME_ERROR);
      const organization = validateOrganization(data.organization);
      if (organization === null) throw fail(400, ORGANIZATION_ERROR);
      const current = auth;
      // A full-access reader credential must never become an administrator credential.
      const shared = await matches(data.password);
      const admin = shared ? null : await adminLogin.verify(data.password);
      const department = admin || shared ? null : departmentLogin.verify(data.password);
      if ((!shared && !admin && !department) || current !== auth) throw fail(401, '访问密码错误');
      return json(res, 200, {csrf: createSession(req, res, username, organization, admin, department).csrf, admin: !!admin});
    }
    const session = sessionFor(req);
    if (!session) throw fail(401, '请先登录');
    const scope = session.department ? departmentLogin.scope(session.department) : null;
    if (session.department && !scope) throw fail(401, '权限已变更，请重新登录');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) throw fail(403, '登录校验已失效，请刷新页面');
    if (route === '/api/session' && req.method === 'GET') {
      // Renew the browser's persistence limit; the server has no 12-hour timeout.
      cookie(req, res, session.token, COOKIE_AGE);
      return json(res, 200, {csrf: session.csrf, admin: !!session.admin});
    }
    if (route === '/api/logout' && req.method === 'POST') {
      sessions.delete(session.token); cookie(req, res, '', 0); return json(res, 200, {ok: true});
    }
    if (route === '/api/admin' || route.startsWith('/api/admin/')) {
      if (!session.admin) throw fail(403, '仅管理员密码登录可使用管理员面板');
      if ((route === '/api/admin/access-requests' && req.method === 'GET') ||
          (route === '/api/admin/access-requests/retry' && req.method === 'POST')) {
        const check = () => {
          const current = sessionFor(req);
          if (!current?.admin || current.token !== session.token || stopping) throw fail(401, '管理员登录已失效，请重新登录');
          return adminLogin.signature(current.admin);
        };
        let result;
        if (req.method === 'GET') {
          const integer = (key, fallback, minimum) => {
            const raw = url.searchParams.get(key);
            if (raw === null) return fallback;
            const value = Number(raw);
            if (url.searchParams.getAll(key).length !== 1 || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum)
              throw fail(400, '申请记录分页参数无效');
            return value;
          };
          result = await accessRequests.page({page: integer('page', 1, 1), snapshot: integer('snapshot', null, 0)});
        } else {
          const data = await body(req);
          result = await accessRequests.retry(data.id, check());
        }
        check(); return json(res, 200, result);
      }
      if (route === '/api/admin/visits' && req.method === 'GET') {
        const integer = (key, fallback, minimum) => {
          const raw = url.searchParams.get(key);
          if (raw === null) return fallback;
          const value = Number(raw);
          if (url.searchParams.getAll(key).length !== 1 || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum)
            throw fail(400, '访问记录分页参数无效');
          return value;
        };
        const data = visitNotifier.visitsPage({page: integer('page', 1, 1), snapshot: integer('snapshot', null, 0)});
        const current = sessionFor(req);
        if (!current?.admin || current.token !== session.token) throw fail(401, '管理员登录已失效，请重新登录');
        return json(res, 200, data);
      }
      const action = route === '/api/admin' && req.method === 'GET' ? 'overview'
        : req.method === 'POST' && ['/api/admin/save-department', '/api/admin/reset-passwords', '/api/admin/view-passwords', '/api/admin/view-request-password', '/api/admin/delete-document', '/api/admin/clear-records', '/api/admin/authorize-request', '/api/admin/generate-request-password'].includes(route)
          ? route.slice('/api/admin/'.length) : null;
      if (!action) throw fail(404, '管理操作不存在');
      const data = action === 'overview' ? undefined : await body(req);
      const value = await serializeMutation(async () => {
        let sharedPassword, prepared;
        if (action === 'reset-passwords' && ['all', 'shared'].includes(data.target)) {
          sharedPassword = crypto.randomBytes(24).toString('base64url');
          const salt = crypto.randomBytes(16).toString('hex');
          prepared = {salt, hash: (await scrypt(sharedPassword, salt, 64)).toString('hex')};
        }
        // Recheck after body reads, queue waits and password hashing; logout/revocation wins.
        const current = sessionFor(req);
        const signature = current?.admin && adminLogin.signature(current.admin);
        if (!signature || current.token !== session.token || stopping) throw fail(401, '管理员登录已失效，请重新登录');
        if (action === 'clear-records') throttleRecordClear(req);
        const resources = {};
        function adoptPassword(updatedAt) {
          auth = prepared; passwordUpdatedAt = updatedAt;
          // User passwords rotate; administrator credentials and sessions stay unchanged.
          for (const [token, value] of sessions) if (!value.admin) sessions.delete(token);
          attempts.clear(); visitNotifier.passwordChanged(updatedAt);
        }
        let result;
        try { result = adminPanel.call(action, {signature, data, sharedPassword, resources}); }
        catch (error) {
          // A lost IPC reply must not leave the previous shared password active after commit.
          if (prepared) {
            const saved = readAccessPassword();
            if (saved.password === sharedPassword) adoptPassword(saved.password_updated_at);
          }
          throw error;
        } finally {
          if (action === 'clear-records') {
            // Forget submitted credentials, even on validation/storage failures.
            delete data.admin_password;
            if (data.target === 'visits') visitNotifier.refreshVisits(!!result?.ok);
          }
        }
        if (prepared) adoptPassword(result.password_updated_at);
        if (action === 'authorize-request') accessRequests.drain();
        return result;
      });
      return json(res, 200, value);
    }
    if (route === '/api/docs' && req.method === 'GET') {
      const {id, versions, read} = revision(url, scope, true);
      if (!id) return json(res, 200, emptyDocs());
      return json(res, 200, publicDocs({bundle: read(), versions}));
    }
    if (route === '/api/compare/options' && req.method === 'GET') return json(res, 200, versionComparison.options(scope));
    if (route === '/api/compare' && req.method === 'GET') {
      const selection = versionComparison.select(url.searchParams, scope);
      const result = await versionComparison.compare(selection);
      // Logout, password resets, scope edits, deletions and superseded packages
      // may occur while the comparison worker runs. Check again before returning data.
      const active = sessionFor(req);
      if (!active || active.token !== session.token) throw fail(401, '登录已失效，请重新登录');
      const currentScope = active.department ? departmentLogin.scope(active.department) : null;
      if (active.department && !currentScope) throw fail(401, '权限已变更，请重新登录');
      if (versionComparison.select(url.searchParams, currentScope).signature !== selection.signature) {
        throw fail(409, '版本内容已更新，请重新选择版本并对比');
      }
      return json(res, 200, result);
    }
    if (route === '/api/feedback' && req.method === 'POST') {
      const finish = feedback.beginSubmission();
      try {
        const data = await body(req, FEEDBACK_BODY_LIMIT);
        const current = sessionFor(req);
        if (!current) throw fail(401, '登录已失效，请重新登录');
        const {attachments, ...fields} = data;
        if (Buffer.byteLength(JSON.stringify(fields)) > 16384) throw fail(413, '留言内容过大');
        const versions = visibleVersions(content('versions.json'), current.department ? departmentLogin.scope(current.department) : null);
        const version = data.document_version || versions.current || '';
        if (version && !versions.versions.some(item => item.id === version)) throw fail(400, '文档版本无效或未获授权，请刷新后重试。');
        return json(res, 201, await feedback.submit(data, visitorInfo(req).ip, version));
      } finally { finish(); }
    }
    if (route === '/api/openapi.json' && req.method === 'GET') {
      const {id, read} = revision(url, scope);
      res.setHeader('Content-Disposition', `attachment; filename="api-${id}.openapi.json"`);
      return json(res, 200, publicDocs({bundle: read(), versions: readRegistry(CONTENT)}).spec);
    }
    throw fail(404, '接口不存在');
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, {error: e.status ? e.message : '文档暂时无法加载，请稍后重试'});
    else res.end();
    if (!e.status) console.error(e.message);
  }
});
server.requestTimeout = 20000; server.headersTimeout = 15000;
setInterval(() => {
  for (const [key, value] of sessions) {
    if ((value.admin && !adminLogin.active(value.admin)) || (value.department && !departmentLogin.active(value.department))) sessions.delete(key);
  }
  for (const [key, value] of attempts) if (value.every(t => t < Date.now() - 600000)) attempts.delete(key);
  for (const [key, value] of recordClearAttempts) if (value.every(t => t < Date.now() - 600000)) recordClearAttempts.delete(key);
}, 60000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true;
  visitNotifier.close();
  feedback.close();
  accessRequests.close();
  passwordAdmin?.close();
  try { updateConfig({server_status: 'stopped', server_pid: null}, {server_pid: process.pid}); }
  catch (error) { console.error(error.message); }
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref();
});
try {
  // Bind before initializing: a failed duplicate start must not change config.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  const localUrl = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${server.address().port}`;
  await initializePassword({
    local_url: localUrl, server_status: 'running', server_pid: process.pid
  });
  departmentLogin.initialize();
  adminPanel.call('recover');
  passwordAdmin = await startPasswordAdmin({state: STATE, config: CONFIG, changePassword: password => serializeMutation(() => setPassword(password))});
  for (const name of ['auth.json', 'initial-password.txt', 'trusted-devices.json']) fs.rmSync(path.join(STATE, name), {force: true});
  console.log(`API Docs listening on ${localUrl}; access config: ${CONFIG}`);
} catch (error) {
  console.error(`文档启动失败：${error.code || error.message}`);
  process.exit(1);
}
