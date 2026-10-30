/** The sole authoring boundary. No source imports, archive extraction, or remote fetching. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const PROTOCOL = 'api-docs/v1';
export const REVISION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;
const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const reserved = new Set(['overview', 'reference', 'catalog', 'models', 'changelog', 'feedback', 'admin', 'compare']);
const MAX_TOTAL = 8 * 1024 * 1024;
const error = message => { throw new Error('Document package rejected: ' + message); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function keys(value, allowed, label) {
  if (!object(value)) error(label + ' must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) error(label + ': unsupported field ' + key);
}
function string(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) error(label + ' is invalid');
}
export function scanText(value) {
  if (/-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/.test(value)) error('possible credential detected');
  if (/\b(?:password|passwd|smtp_password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*["']?(?!YOUR_|EXAMPLE_|REPLACE_|<|\$\{|\{\{)[A-Za-z0-9+/_-]{16,}/i.test(value)) error('possible embedded credential; use a placeholder');
}
function inspectJSON(value, depth = 0) {
  if (depth > 40) error('JSON nesting exceeds 40 levels');
  if (typeof value === 'string') { scanText(value); return; }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value) && value.length > 10000) error('JSON array is too large');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) error('unsafe JSON key');
    scanText(key); inspectJSON(child, depth + 1);
  }
}
export function parseJSON(text) {
  let value;
  try { value = JSON.parse(text); } catch { error('invalid JSON'); }
  // JSON.parse accepts duplicate keys; refuse ambiguous authoring manifests/contracts.
  const stack = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
    const token = match[0], top = stack.at(-1);
    if (token === '{') stack.push({keys: new Set(), key: true});
    else if (token === '[') stack.push({key: false});
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && top?.keys) top.key = true;
    else if (token === ':' && top?.keys) top.key = false;
    else if (token.startsWith('"') && top?.key) {
      const name = JSON.parse(token);
      if (top.keys.has(name)) error('duplicate JSON key');
      top.keys.add(name);
    }
  }
  inspectJSON(value); return value;
}
export function assertNoSymlinks(filename) {
  let current = path.resolve(filename);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) error('symbolic links are not allowed'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export function readFile(filename, maximum = MAX_TOTAL) {
  assertNoSymlinks(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || stat.nlink !== 1) error('invalid file type, size, or hard link');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0, n;
    while ((n = fs.readSync(fd, bytes, size, bytes.length - size, null)) > 0) {
      size += n; if (size > stat.size) error('file changed during validation');
    }
    if (size !== stat.size) error('file changed during validation');
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, size));
    if (text.includes('\0')) error('binary content is not allowed');
    scanText(text); return text;
  } finally { fs.closeSync(fd); }
}

export function validateManifest(manifest) {
  inspectJSON(manifest);
  keys(manifest, ['protocol', 'visibility', 'revision', 'productVersion', 'publishedAt', 'site', 'guides', 'openapi', 'changes'], 'docs.json');
  if (manifest.protocol !== PROTOCOL || manifest.visibility !== 'public') error('protocol must be api-docs/v1 and visibility must be public');
  if (!REVISION.test(manifest.revision || '') || manifest.revision.includes('..')) error('invalid revision');
  string(manifest.productVersion, 'productVersion', 64);
  if (typeof manifest.publishedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(manifest.publishedAt) || !Number.isFinite(Date.parse(manifest.publishedAt))) error('publishedAt needs an ISO timestamp with timezone');
  keys(manifest.site, ['name', 'title', 'description'], 'site');
  for (const key of ['name', 'title', 'description']) string(manifest.site[key], 'site.' + key, key === 'description' ? 2000 : 120);
  if (!Array.isArray(manifest.guides) || manifest.guides.length > 100) error('guides must be an array with at most 100 entries');
  const ids = new Set(), files = new Set(['docs.json']);
  for (const guide of manifest.guides) {
    keys(guide, ['id', 'title', 'description', 'group', 'file'], 'guide');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(guide.id || '') || reserved.has(guide.id) || ids.has(guide.id)) error('invalid or duplicate guide id');
    string(guide.title, 'guide.title', 120); string(guide.group, 'guide.group', 80);
    if (guide.description !== undefined) string(guide.description, 'guide.description', 1000);
    if (!/^guides\/[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(guide.file || '') || files.has(guide.file)) error('guide files must be unique guides/name.md paths');
    ids.add(guide.id); files.add(guide.file);
  }
  if (manifest.openapi !== undefined) {
    if (manifest.openapi !== 'openapi.json') error('openapi must be openapi.json');
    files.add('openapi.json');
  }
  if (!manifest.guides.length && !manifest.openapi) error('at least one guide or OpenAPI document is required');
  if (manifest.changes !== undefined) {
    keys(manifest.changes, ['title', 'added', 'changed', 'compatibility', 'validation'], 'changes');
    string(manifest.changes.title, 'changes.title');
    for (const key of ['added', 'changed', 'compatibility', 'validation']) if (manifest.changes[key] !== undefined) {
      if (!Array.isArray(manifest.changes[key]) || manifest.changes[key].length > 50) error('invalid change list');
      for (const text of manifest.changes[key]) string(text, 'change', 2000);
    }
  }
  return files;
}

const fields = {
  root: ['openapi', 'info', 'servers', 'tags', 'paths', 'components', 'security'],
  info: ['title', 'version', 'description', 'termsOfService', 'contact', 'license'],
  contact: ['name', 'url', 'email'], license: ['name', 'url', 'identifier'],
  server: ['url', 'description', 'variables'], variable: ['enum', 'default', 'description'],
  tag: ['name', 'description'],
  path: [...methods, 'summary', 'description', 'parameters', 'servers'],
  operation: ['x-audience', 'operationId', 'summary', 'description', 'tags', 'parameters', 'requestBody', 'responses', 'security', 'servers', 'deprecated'],
  schema: ['$ref', 'title', 'description', 'type', 'format', 'properties', 'required', 'items', 'additionalProperties', 'allOf', 'oneOf', 'anyOf', 'not', 'nullable', 'readOnly', 'writeOnly', 'deprecated', 'enum', 'const', 'default', 'example', 'examples', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'discriminator', 'prefixItems'],
  parameter: ['$ref', 'name', 'in', 'description', 'required', 'deprecated', 'allowEmptyValue', 'style', 'explode', 'allowReserved', 'schema', 'example', 'examples', 'content'],
  header: ['$ref', 'description', 'required', 'deprecated', 'style', 'explode', 'schema', 'example', 'examples', 'content'],
  body: ['$ref', 'description', 'required', 'content'], response: ['$ref', 'description', 'headers', 'content'],
  media: ['schema', 'example', 'examples', 'encoding'], example: ['$ref', 'summary', 'description', 'value'],
  encoding: ['contentType', 'headers', 'style', 'explode', 'allowReserved'],
  securityScheme: ['$ref', 'type', 'description', 'name', 'in', 'scheme', 'bearerFormat', 'flows', 'openIdConnectUrl'],
  flow: ['authorizationUrl', 'tokenUrl', 'refreshUrl', 'scopes']
};
const components = {schemas: 'schema', parameters: 'parameter', headers: 'header', requestBodies: 'body', responses: 'response', examples: 'example', securitySchemes: 'securityScheme'};
export function validateOpenAPI(spec) {
  inspectJSON(spec);
  const refs = [], operationIds = new Set();
  function array(value, visit, label) { if (!Array.isArray(value)) error(label + ' must be an array'); value.forEach(visit); }
  function map(value, visit, label) { if (!object(value)) error(label + ' must be an object'); for (const [key, item] of Object.entries(value)) visit(item, key); }
  function node(value, kind) {
    if (kind === 'schema' && typeof value === 'boolean') return;
    keys(value, fields[kind], kind);
    for (const [key, item] of Object.entries(value)) {
      if (['title', 'description', 'summary', 'operationId', 'format', 'pattern', 'name', 'in', 'scheme', 'bearerFormat', 'email', 'version', 'identifier', 'contentType', 'style', 'x-audience'].includes(key)) string(item, kind + '.' + key, ['description', 'summary'].includes(key) ? 32000 : 2000);
      if (['deprecated', 'nullable', 'readOnly', 'writeOnly', 'uniqueItems', 'allowEmptyValue', 'allowReserved', 'explode'].includes(key) && typeof item !== 'boolean') error(key + ' must be boolean');
      if (['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key) && (typeof item !== 'number' || !Number.isFinite(item))) error(key + ' must be a number');
      if (key === 'required') {
        if (kind === 'schema') array(item, name => string(name, 'required field'), key);
        else if (typeof item !== 'boolean') error('required must be boolean');
      }
      if (key === 'tags' || (key === 'type' && Array.isArray(item))) array(item, text => string(text, key), key);
      if (key === 'type' && !Array.isArray(item)) string(item, 'type');
      if (key === 'enum' || (key === 'examples' && kind === 'schema')) array(item, () => {}, key);
      if (key === 'additionalProperties' && !object(item) && typeof item !== 'boolean') error('invalid additionalProperties');
      if (key === '$ref') { if (typeof item !== 'string' || !/^#\/components\/(schemas|parameters|headers|requestBodies|responses|examples|securitySchemes)\/[^/]+$/.test(item)) error('only local component references are supported'); refs.push(item); }
      else if (key === 'schema' || key === 'items' || key === 'not' || (key === 'additionalProperties' && object(item))) node(item, 'schema');
      else if (key === 'properties') map(item, child => node(child, 'schema'), key);
      else if (['oneOf', 'anyOf', 'allOf', 'prefixItems'].includes(key)) array(item, child => node(child, 'schema'), key);
      else if (key === 'content') map(item, child => node(child, 'media'), key);
      else if (key === 'headers') map(item, child => node(child, 'header'), key);
      else if (key === 'encoding') map(item, child => node(child, 'encoding'), key);
      else if (key === 'parameters') array(item, child => node(child, 'parameter'), key);
      else if (key === 'servers') array(item, child => node(child, 'server'), key);
      else if (key === 'variables') map(item, child => node(child, 'variable'), key);
      else if (key === 'requestBody') node(item, 'body');
      else if (key === 'responses') map(item, (child, code) => { if (!/^(default|[1-5](?:[0-9]{2}|XX))$/.test(code)) error('invalid response code'); node(child, 'response'); }, key);
      else if (key === 'examples' && kind !== 'schema') map(item, child => node(child, 'example'), key);
      else if (key === 'contact' || key === 'license') node(item, key);
      else if (key === 'discriminator') { keys(item, ['propertyName', 'mapping'], key); if (item.mapping) map(item.mapping, ref => { if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) error('discriminator mappings must be local refs'); refs.push(ref); }, 'mapping'); }
      else if (key === 'flows') { keys(item, ['implicit', 'password', 'clientCredentials', 'authorizationCode'], key); Object.values(item).forEach(flow => node(flow, 'flow')); }
      else if (key === 'scopes') map(item, text => string(text, 'scope', 2000), key);
      else if (key === 'security') array(item, requirement => map(requirement, (scopes, name) => { if (!spec.components?.securitySchemes?.[name]) error('unknown security scheme'); array(scopes, scope => string(scope, 'scope'), 'scopes'); }, 'security requirement'), key);
      else if (kind === 'path' && methods.includes(key)) {
        if (item['x-audience'] !== 'public') error('each operation must declare x-audience: public');
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(item.operationId || '') || operationIds.has(item.operationId)) error('operations need unique operationId values');
        operationIds.add(item.operationId);
        if (!object(item.responses) || !Object.keys(item.responses).length) error('operations need responses');
        node(item, 'operation');
      }
      else if (['url', 'termsOfService', 'authorizationUrl', 'tokenUrl', 'refreshUrl', 'openIdConnectUrl'].includes(key)) {
        if (typeof item !== 'string' || !/^https?:\/\//.test(item) || /[\x00-\x20\\]/.test(item)) error('URLs must use HTTP(S)');
        try { const url = new URL(item); if (url.username || url.password) error('credentials in URLs are forbidden'); } catch { error('invalid URL'); }
      }
    }
  }
  keys(spec, fields.root, 'OpenAPI');
  if (!/^3\.(0\.\d+|1\.\d+)$/.test(spec.openapi || '')) error('OpenAPI 3.0 or 3.1 is required');
  node(spec.info, 'info'); string(spec.info.title, 'info.title'); string(spec.info.version, 'info.version', 64);
  if (spec.servers) array(spec.servers, item => node(item, 'server'), 'servers');
  if (spec.tags) array(spec.tags, item => node(item, 'tag'), 'tags');
  map(spec.paths, (item, route) => { if (!route.startsWith('/') || /[\x00-\x20\\]/.test(route) || route.length > 2048) error('invalid API path'); node(item, 'path'); }, 'paths');
  if (spec.components) {
    keys(spec.components, Object.keys(components), 'components');
    for (const [key, values] of Object.entries(spec.components)) map(values, value => node(value, components[key]), key);
  }
  if (spec.security) node({security: spec.security}, 'operation');
  for (const ref of refs) {
    let found = spec;
    for (const part of ref.slice(2).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))) found = object(found) && Object.hasOwn(found, part) ? found[part] : undefined;
    if (found === undefined) error('unresolved component reference');
  }
  return spec;
}

export function validateBundle(bundle) {
  keys(bundle, ['protocol', 'manifest', 'markdown', 'openapi'], 'compiled document');
  if (bundle.protocol !== PROTOCOL) error('unsupported compiled protocol');
  const files = validateManifest(bundle.manifest);
  if (!object(bundle.markdown)) error('missing Markdown map');
  const expected = bundle.manifest.guides.map(guide => guide.id).sort();
  if (JSON.stringify(Object.keys(bundle.markdown).sort()) !== JSON.stringify(expected)) error('unexpected Markdown entries');
  for (const text of Object.values(bundle.markdown)) { string(text, 'Markdown', 512 * 1024); scanText(text); }
  if (files.has('openapi.json')) validateOpenAPI(bundle.openapi);
  else if (bundle.openapi !== null) error('undeclared OpenAPI document');
  return bundle;
}

export function loadPackage(directory) {
  const root = path.resolve(directory); assertNoSymlinks(root);
  if (!fs.lstatSync(root).isDirectory()) error('package must be a directory');
  const manifest = parseJSON(readFile(path.join(root, 'docs.json'), 64 * 1024));
  const allowed = validateManifest(manifest), found = new Set(); let total = 0;
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory() && name === 'guides' && manifest.guides.length) walk(name);
      else if (!entry.isFile() || !allowed.has(name)) error('unexpected file or directory: ' + name);
      else { found.add(name); total += fs.lstatSync(path.join(root, name)).size; if (total > MAX_TOTAL) error('package exceeds 8 MiB'); }
    }
  }
  walk(); if (found.size !== allowed.size) error('a declared document is missing');
  const markdown = Object.fromEntries(manifest.guides.map(guide => [guide.id, readFile(path.join(root, guide.file), 512 * 1024)]));
  const openapi = manifest.openapi ? parseJSON(readFile(path.join(root, 'openapi.json'), 4 * 1024 * 1024)) : null;
  return validateBundle({protocol: PROTOCOL, manifest, markdown, openapi});
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
