import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createVisitHistory, HISTORY_NAME, HISTORY_DATABASE} from '../visit-history.mjs';
import {createVisitNotifier} from '../visit-notifier.mjs';

function temporary(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-visits-'));
  t.after(() => fs.rmSync(state, {recursive: true, force: true}));
  return state;
}
const visit = n => ({time: `2026-10-12T00:00:${String(n).padStart(2, '0')}.000Z`,
  ip: `203.0.113.${n}`, browser: 'Chrome 140', os: 'Linux',
  password: 'EXAMPLE_PASSWORD', cookie: 'PRIVATE-COOKIE', userAgent: 'PRIVATE-EXTRA'});

test('history listing is read-only, sanitized, isolated from caller edits and does not enqueue mail', t => {
  const state = temporary(t), file = path.join(state, HISTORY_NAME), history = createVisitHistory({state});
  assert.deepEqual(history.list(), []); assert.ok(!fs.existsSync(file));
  for (let n = 1; n <= 12; n++) history.append({...visit(n), loginType: 'department', company: '示例公司', department: '开发部'});
  const before = fs.readFileSync(file), listed = history.list();
  assert.equal(listed.length, 10); assert.equal(listed[0].ip, '203.0.113.12');
  listed[0].company = 'tampered'; listed.pop();
  assert.equal(history.list()[0].company, '示例公司'); assert.equal(history.list().length, 10);
  assert.deepEqual(fs.readFileSync(file), before);
  let workers = 0;
  const notifier = createVisitNotifier({state, run: () => {workers++; throw new Error('Unexpected email');}});
  t.after(() => notifier.close());
  const data = notifier.recentVisits();
  assert.deepEqual(data, {limit: 10, visits: history.list()});
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE|password|cookie|userAgent/);
  assert.equal(workers, 0); assert.deepEqual(fs.readFileSync(file), before);
});

test('all visits persist across restarts while the email cache keeps ten, with private permissions and selected fields', t => {
  const state = temporary(t), file = path.join(state, HISTORY_NAME), history = createVisitHistory({state});
  for (let n = 1; n <= 12; n++) history.append(visit(n));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.visits.map(v => v.ip), Array.from({length: 10}, (_, n) => `203.0.113.${12 - n}`));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|password|cookie|userAgent/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(state).sort(), [HISTORY_NAME, HISTORY_DATABASE].sort());
  assert.equal(fs.statSync(path.join(state, HISTORY_DATABASE)).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(state, HISTORY_DATABASE)).includes(Buffer.from('PRIVATE')));
  const all = createVisitHistory({state}).page({page: 2});
  assert.equal(all.total, 12); assert.equal(all.pages, 2);
  assert.deepEqual(all.visits.map(row => row.ip), ['203.0.113.2', '203.0.113.1']);
  const restarted = createVisitHistory({state}).append(visit(13));
  assert.equal(restarted.length, 10);
  assert.equal(restarted[0].ip, '203.0.113.13');
  assert.equal(restarted[9].ip, '203.0.113.4');
});

test('corrupt history recovers without echoing its contents and old fields are normalized', t => {
  const state = temporary(t), file = path.join(state, HISTORY_NAME), warnings = [];
  fs.writeFileSync(file, 'PRIVATE-BROKEN-FILE', {mode: 0o600});
  assert.equal(createVisitHistory({state, warn: value => warnings.push(value)}).append(visit(1)).length, 1);
  assert.deepEqual(warnings, ['history_read_failed']);
  const legacyState = temporary(t);
  fs.writeFileSync(path.join(legacyState, HISTORY_NAME), JSON.stringify({version: 1, visits: [null, {time: 'invalid'},
    {...visit(1), ip: 'invalid', browser: 'Chrome\r\nInjected: header' + 'x'.repeat(1000)}]}));
  const records = createVisitHistory({state: legacyState}).append(visit(2));
  assert.equal(records.length, 2); assert.equal(records[1].ip, '未知');
  assert.equal(records[1].browser.length, 80); assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
  assert.doesNotMatch(records[1].browser, /[\r\n]/);
});

test('a history write failure keeps the current visit available for email without failing login', t => {
  const state = path.join(temporary(t), 'blocked'), warnings = [];
  fs.writeFileSync(state, 'PRIVATE');
  const history = createVisitHistory({state, warn: value => warnings.push(value)});
  assert.equal(history.append(visit(1))[0].ip, '203.0.113.1');
  assert.equal(history.append(visit(2)).length, 2);
  assert.ok(warnings.includes('history_write_failed'));
  assert.doesNotMatch(warnings.join('\n'), /PRIVATE|203\.0\.113/);
});

test('organization snapshots survive restart, legacy entries remain unattributed and only approved fields persist', t => {
  const state = temporary(t), file = path.join(state, HISTORY_NAME);
  fs.writeFileSync(file, JSON.stringify({version: 1, visits: [visit(1)]}));
  const event = {...visit(2), loginType: 'department', company: '甲公司', department: '研发部', signature: 'PRIVATE-SIGNATURE'};
  const history = createVisitHistory({state}); history.append(event);
  event.company = '更名后的公司'; event.department = '其他部门';
  const records = createVisitHistory({state}).append({...visit(3), loginType: 'shared', company: 'FORGED', department: 'FORGED'});
  assert.equal(records[1].company, '甲公司'); assert.equal(records[1].department, '研发部');
  assert.equal(records[0].company, ''); assert.equal(records[0].department, ''); assert.equal(records[0].loginType, 'shared');
  assert.equal(records[2].loginType, 'unknown'); assert.equal(records[2].company, '');
  const sanitized = history.append({...visit(4), loginType: 'department', company: '机构\r\n' + 'x'.repeat(200), department: {secret: 'PRIVATE'}})[0];
  assert.equal(sanitized.company.length, 120); assert.doesNotMatch(sanitized.company, /[\r\n]/); assert.equal(sanitized.department, '');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE|FORGED|signature|password|cookie/);
});

test('queued notifications retain the ten-visit snapshot for their own login', t => {
  const state = temporary(t), payloads = [], complete = [];
  const notifier = createVisitNotifier({state, run: (python, args, options, done) => {
    complete.push(done);
    return {stdin: {on() {}, end(value) {payloads.push(JSON.parse(value));}}, kill() {}};
  }});
  t.after(() => notifier.close());
  const identity = {loginType: 'department', company: '测试公司', department: ''};
  for (let n = 1; n <= 12; n++) {
    identity.department = '部门' + n;
    notifier.notify({socket: {remoteAddress: `203.0.113.${n}`}, headers: {company: 'FORGED'}}, {identity});
  }
  identity.company = 'QUEUE-MUTATION';
  assert.equal(payloads.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, HISTORY_NAME))).visits.length, 10);
  for (let n = 0; n < 12; n++) complete[n](null, '{"status":"accepted"}');
  for (let n = 0; n < 12; n++) {
    const recent = payloads[n].recentVisits;
    assert.equal(recent.length, Math.min(n + 1, 10));
    assert.equal(recent[0].ip, payloads[n].ip);
    assert.equal(payloads[n].company, '测试公司'); assert.equal(payloads[n].department, '部门' + (n + 1));
    assert.equal(recent[0].company, '测试公司'); assert.equal(recent[0].department, payloads[n].department);
    assert.deepEqual(recent.map(v => v.ip), Array.from({length: recent.length}, (_, i) => `203.0.113.${n + 1 - i}`));
  }
});
