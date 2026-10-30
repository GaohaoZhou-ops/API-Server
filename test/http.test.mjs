import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadPackage} from '../document-protocol.mjs';
import {publish} from '../publications.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), python = process.env.API_DOCS_PYTHON || '/usr/bin/python3';
test('HTTP authorization, application passwords, feedback, publication boundary and revocation', {timeout: 45000}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-docs-http-')), content = path.join(temp, 'content'), config = path.join(temp, 'config');
  const shared = 'EXAMPLE_SHARED_READER_PASSWORD', admin = 'EXAMPLE_ADMINISTRATOR_PASSWORD';
  fs.mkdirSync(config, {mode: 0o700});
  for (const [group, value] of Object.entries({access: {password: shared, admin_password: admin}, email: {enabled: true, sender: 'sender@example.test', recipient: 'admin@example.test', smtp_host: 'smtp.example.test', smtp_port: 465, smtp_security: 'ssl', smtp_password: 'EXAMPLE_SMTP_PASSWORD', access_url: 'https://docs.example.test/'}, runtime: {}})) fs.writeFileSync(path.join(config, group + '.yaml'), JSON.stringify(value), {mode: 0o600});
  const bundle = loadPackage(path.join(root, 'examples/hello-docs')); publish(bundle, content);
  bundle.manifest.revision = '1.0.1'; bundle.openapi.paths['/status'].get.summary = 'Updated status'; publish(bundle, content);
  const env = {...process.env, API_DOCS_CONFIG: config, API_DOCS_STATE: path.join(temp, 'state'), API_DOCS_CONTENT_ROOT: content, API_DOCS_PORT: '0', API_DOCS_HOST: '127.0.0.1', API_DOCS_PYTHON: path.join(root, 'test/fixtures/offline-python.py'), API_DOCS_NODE: process.execPath};
  const child = spawn(process.execPath, ['docs-server.mjs'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  let logs = ''; child.stderr.on('data', chunk => logs += chunk);
  t.after(async () => { if (child.exitCode === null) {const done = once(child, 'exit'); child.kill(); await done;} fs.rmSync(temp, {recursive: true, force: true}); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + logs)), 10000);
    child.stdout.on('data', chunk => {const found = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (found) {clearTimeout(timer); resolve(found[0]);}});
    child.once('exit', () => {clearTimeout(timer); reject(new Error('Startup failed: ' + logs));}); child.once('error', reject);
  });
  function browser() {
    let cookie = '', csrf = '';
    const request = async (route, data, headers = {}) => {
      const response = await fetch(base + route, {method: data === undefined ? 'GET' : 'POST', headers: {Cookie: cookie, ...(data === undefined ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}), ...headers}, body: data === undefined ? undefined : JSON.stringify(data)});
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return response;
    };
    return {request, async login(password) {const response = await request('/api/login', {username: 'QA Reader', organization: 'Example Team', password}); const value = await response.json(); assert.equal(response.status, 200, value.error); csrf = value.csrf; return value;}};
  }
  const visitor = browser(), reader = browser(), manager = browser();
  assert.equal((await visitor.request('/api/docs')).status, 401);
  assert.equal((await reader.login(shared)).admin, false); assert.equal((await reader.request('/api/admin')).status, 403);
  assert.equal((await manager.login(admin)).admin, true);
  for (const account of [visitor, reader, manager]) for (const route of ['/docs-server.mjs', '/scripts/runtime.py', '/var/config/access.yaml', '/config.yaml', '/.git/config', '/content/versions.json', '/var/content/versions/1.0.0/document.json', '/api/source', '/api/snapshot', '/api/manifest.json', '/api/password', '/api/mocks/download/business', '/api/web-ui/download/business', '/api/robot-models']) {
    assert.ok([401, 404].includes((await account.request(route)).status), route);
  }
  const docs = await (await reader.request('/api/docs')).json(); assert.equal(docs.site.revision, '1.0.1'); assert.equal(docs.site.guides.length, 2);
  assert.equal((await reader.request('/api/docs?version=../../secret')).status, 404);
  const compare = await (await reader.request('/api/compare?kind=api&from=1.0.0&to=1.0.1')).json(); assert.equal(compare.counts.modified, 1);
  assert.equal((await reader.request('/api/compare?kind=web-ui&from=1&to=2')).status, 400);
  const overview = async () => (await manager.request('/api/admin')).json();
  let snapshot = await overview();
  assert.equal((await manager.request('/api/admin/save-department', {revision: snapshot.revision}, {'X-CSRF-Token': 'wrong'})).status, 403);
  const savedResponse = await manager.request('/api/admin/save-department', {revision: snapshot.revision, company: 'Example Company', department: 'Engineering', enabled: true, api_versions: ['1.0.0']});
  const saved = await savedResponse.json(); assert.equal(savedResponse.status, 200, saved.error);
  const department = browser(); await department.login(saved.generated[0].password);
  const limited = await (await department.request('/api/docs')).json(); assert.deepEqual(limited.versions.versions.map(item => item.id), ['1.0.0']);
  assert.equal((await department.request('/api/openapi.json?version=1.0.1')).status, 403);
  assert.equal((await department.request('/api/compare?kind=api&from=1.0.0&to=1.0.1')).status, 404);
  const application = await visitor.request('/api/access-requests', {submission_id: randomUUID(), name: 'Example Applicant', email: 'applicant@example.test', organization: 'Example Company'});
  assert.equal(application.status, 201, JSON.stringify(await application.json()));
  const requests = await (await manager.request('/api/admin/access-requests')).json();
  const record = requests.requests[0]; snapshot = await overview();
  const identity = {revision: snapshot.revision, id: record.id, request_token: record.request_token, company: 'Example Company', department: 'Engineering', operation_id: randomUUID(), expected_grant_id: null};
  const generation = await manager.request('/api/admin/generate-request-password', identity), generated = await generation.json(); assert.equal(generation.status, 200, generated.error);
  const grant = await manager.request('/api/admin/authorize-request', {...identity, operation_id: randomUUID(), draft_id: generated.draft_id}); const granted = await grant.json(); assert.equal(grant.status, 200, granted.error);
  const applicant = browser(); await applicant.login(generated.password);
  assert.equal((await applicant.request('/api/openapi.json?version=1.0.1')).status, 403);
  snapshot = await overview();
  const view = await manager.request('/api/admin/view-request-password', {revision: snapshot.revision, id: record.id, request_token: record.request_token, expected_grant_id: granted.authorization.id});
  assert.equal(view.status, 200, JSON.stringify(await view.json()));
  const feedback = await reader.request('/api/feedback', {submission_id: randomUUID(), name: 'QA', email: 'qa@example.test', organization: 'Example', category: '其他', message: 'Offline feedback regression', document_version: '1.0.0', attachments: []});
  assert.equal(feedback.status, 201, JSON.stringify(await feedback.json()));
  assert.equal((await reader.request('/api/logout', {}, {Origin: 'https://untrusted.example'})).status, 403);
  assert.equal((await reader.request('/api/logout', {})).status, 200); assert.equal((await reader.request('/api/docs')).status, 401);
  const policyFile = path.join(config, 'permissions.yaml');
  execFileSync(python, ['-c', "import yaml,sys; p=sys.argv[1]; d=yaml.safe_load(open(p)); d['companies']['Example Company']['departments']['Engineering']['enabled']=False; open(p,'w').write(yaml.safe_dump(d))", policyFile]);
  assert.equal((await applicant.request('/api/session')).status, 401); assert.equal((await department.request('/api/session')).status, 401);
  assert.doesNotMatch(logs, new RegExp(shared + '|' + admin + '|' + generated.password));
});
