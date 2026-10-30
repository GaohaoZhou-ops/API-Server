import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ROOT, PYTHON} from './runtime.mjs';
import {publicOpenAPI} from './public-docs.mjs';
import {visibleVersions} from './version-permissions.mjs';
import {readRegistry, readPublication} from './publications.mjs';
import {publicDocs} from './public-docs.mjs';

const fail = (status, message) => Object.assign(new Error(message), {status});
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const hash = text => createHash('sha256').update(text).digest('hex');
// Object key order is not an API change. Array order (e.g. examples) is retained.
export function stableJSON(value) {
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(value), null, 2) + '\n';
}
function textEntry(key, label, kind, value, extra = {}) {
  const text = stableJSON(value), bytes = Buffer.byteLength(text);
  return {key, label, kind, ...extra, bytes, sha256: hash(text),
    preview: bytes <= 256 * 1024 && text.split('\n').length <= 5000 ? 'text' : 'large', text};
}
function references(spec, value) {
  const result = new Map();
  function add(ref) {
    if (typeof ref !== 'string' || !ref.startsWith('#/components/') || result.has(ref)) return;
    const parts = ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let found = spec;
    for (const part of parts) found = found && Object.hasOwn(found, part) ? found[part] : undefined;
    if (found === undefined) return;
    result.set(ref, found); walk(found);
  }
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) add(value.$ref);
    if (Array.isArray(value.security)) for (const item of value.security) for (const name of Object.keys(item)) {
      add('#/components/securitySchemes/' + name.replace(/~/g, '~0').replace(/\//g, '~1'));
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(value);
  return Object.fromEntries(result);
}
export function apiEntries(raw) {
  // This is the SAME allowlist as the existing OpenAPI download. Never read source snapshots.
  const spec = publicOpenAPI(raw), entries = [];
  const add = (key, label, kind, value, extra) => entries.push(textEntry(key, label, kind,
    {...value, referencedDefinitions: references(spec, value)}, extra));
  for (const [route, item] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    const parameters = new Map();
    for (const param of [...(item.parameters || []), ...(operation.parameters || [])]) {
      let resolved = param;
      if (param.$ref) resolved = references(spec, param)[param.$ref] || param;
      parameters.set(resolved.$ref || `${resolved.in}:${resolved.name}`, param);
    }
    add(`operation:${method.toUpperCase()} ${route}`, operation.summary || route, 'operation',
      {method: method.toUpperCase(), path: route, servers: spec.servers, ...operation,
        security: operation.security ?? spec.security,
        parameters: [...parameters].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)},
      {method: method.toUpperCase(), path: route});
  }
  for (const [group, values] of Object.entries(spec.components)) for (const [name, value] of Object.entries(values)) {
    add(`component:${group}/${name}`, name, group === 'schemas' ? 'schema' : 'component', {definition: value}, {group});
  }
  add('settings', '公共设置', 'settings', {openapi: spec.openapi, servers: spec.servers, security: spec.security});
  return entries;
}
const metadata = entry => entry ? Object.fromEntries(['bytes', 'sha256', 'preview'].map(key => [key, entry[key]])) : null;
export function compareEntries(before, after) {
  const old = new Map(before.map(item => [item.key, item])), next = new Map(after.map(item => [item.key, item]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().map(key => {
    const a = old.get(key), b = next.get(key), item = b || a;
    const status = !a ? 'added' : !b ? 'removed' : a.sha256 === b.sha256 ? 'unchanged' : 'modified';
    return {key, label: item.label, kind: item.kind, ...(item.method ? {method: item.method, path: item.path} : {}),
      ...(item.group ? {group: item.group} : {}), status, before: metadata(a), after: metadata(b)};
  });
}

export function createVersionComparison({contentRoot, python = PYTHON}) {
  let running = 0;
  const registry = () => readRegistry(contentRoot);
  function options(scope) {
    return {api: visibleVersions(registry(), scope).versions.map(({id, label, published_at}) => ({id, label, published_at}))};
  }
  function select(params, scope) {
    const kind = params.get('kind'), ids = [params.get('from'), params.get('to')];
    if (kind !== 'api') throw fail(400, '仅支持 API 文档对比');
    const available = visibleVersions(registry(), scope).versions;
    const sources = ids.map(id => {
      const entry = available.find(item => item.id === id);
      if (!entry) throw fail(404, '文档版本不存在或未获授权');
      return {id, label: entry.label, stamp: entry.sha256};
    });
    const item = params.get('item');
    if (item !== null && (!item || item.length > 2048)) throw fail(400, '对比条目无效');
    return {kind, sources, item, signature: JSON.stringify(sources)};
  }
  async function helper(data) {
    if (running >= 2) throw fail(429, '正在处理其他对比，请稍后重试');
    running++;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(python, [path.join(ROOT, 'scripts', 'compare_versions.py')], {stdio: ['pipe', 'pipe', 'ignore']});
        const chunks = []; let size = 0, timedOut = false;
        const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, 15000);
        child.stdout.on('data', chunk => {size += chunk.length; if (size > 8 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk);});
        child.on('error', () => {clearTimeout(timer); reject(fail(503, '对比服务暂不可用'));});
        child.stdin.on('error', () => {});
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0 || timedOut || size > 8 * 1024 * 1024) return reject(fail(422, '内容超过在线对比限制，请下载后比较'));
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (value.error) reject(fail(value.status, value.error)); else resolve(value);
          } catch { reject(fail(503, '对比结果暂不可用')); }
        });
        child.stdin.end(JSON.stringify(data));
      });
    } finally { running--; }
  }
  async function compare(selection) {
    const {kind, sources, item} = selection;
    let lines;
    const pair = sources.map(source => apiEntries(publicDocs({bundle: readPublication(contentRoot, source.id), versions: registry()}).spec));
    const items = compareEntries(...pair);
    const result = {kind, from: {id: sources[0].id, label: sources[0].label}, to: {id: sources[1].id, label: sources[1].label}};
    if (item !== null) {
      const row = items.find(value => value.key === item);
      if (!row) throw fail(404, '对比条目不存在');
      const selected = pair.map(entries => entries.find(value => value.key === item));
      if (kind === 'api' && selected.every(value => !value || value.preview === 'text')) {
        lines = (await helper({action: 'diff', before: selected[0]?.text ?? null, after: selected[1]?.text ?? null})).lines;
      }
      return {...result, item: row, lines: lines ?? null};
    }
    const counts = {added: 0, modified: 0, removed: 0, unchanged: 0};
    for (const value of items) counts[value.status]++;
    return {...result, counts, items};
  }
  return {options, select, compare};
}
