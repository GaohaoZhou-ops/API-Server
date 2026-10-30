import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {assertNoSymlinks, readFile, parseJSON, validateBundle, digest, REVISION} from './document-protocol.mjs';

export function readRegistry(root) {
  const value = parseJSON(readFile(path.join(root, 'versions.json'), 512 * 1024));
  if (!value || Object.keys(value).sort().join(',') !== 'current,versions' || !Array.isArray(value.versions) || !value.versions.length || value.versions.length > 1000) throw new Error('Invalid publication registry');
  const ids = new Set();
  for (const item of value.versions) {
    if (!item || Object.keys(item).sort().join(',') !== 'id,label,published_at,sha256,version' || !REVISION.test(item.id || '') || item.id.includes('..') || ids.has(item.id) || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || typeof item.label !== 'string' || item.label.length > 200 || typeof item.version !== 'string' || item.version.length > 64 || !Number.isFinite(Date.parse(item.published_at))) throw new Error('Invalid publication entry');
    ids.add(item.id);
  }
  if (!ids.has(value.current)) throw new Error('Invalid default revision');
  return value;
}

export function readPublication(root, id) {
  const item = readRegistry(root).versions.find(item => item.id === id);
  if (!item) throw Object.assign(new Error('文档版本不存在'), {status: 404});
  const text = readFile(path.join(root, 'versions', id, 'document.json'), 12 * 1024 * 1024);
  if (digest(text) !== item.sha256) throw new Error('Publication integrity check failed');
  const bundle = validateBundle(parseJSON(text));
  if (bundle.manifest.revision !== id) throw new Error('Publication revision mismatch');
  return bundle;
}

function atomic(file, text) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(temporary, {force: true}); }
}

/** Caller holds the shared admin-panel lock. A catalog swap is the visibility boundary. */
export function publish(bundle, root) {
  validateBundle(bundle); root = path.resolve(root); assertNoSymlinks(root);
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const index = path.join(root, 'versions.json');
  if (fs.existsSync(path.join(root, '.admin-delete.json'))) throw new Error('Start the server to finish the pending document deletion before publishing');
  const registry = fs.existsSync(index) ? readRegistry(root) : {current: null, versions: []};
  if (registry.versions.length >= 1000 && !registry.versions.some(item => item.id === bundle.manifest.revision)) throw new Error('Publication limit reached');
  const text = JSON.stringify(bundle, null, 2) + '\n', sha256 = digest(text);
  if (Buffer.byteLength(text) > 12 * 1024 * 1024) throw new Error('Compiled document exceeds 12 MiB');
  const manifest = bundle.manifest, id = manifest.revision;
  const destination = path.join(root, 'versions', id), file = path.join(destination, 'document.json');
  assertNoSymlinks(destination);
  const existing = registry.versions.find(item => item.id === id);
  if (existing && existing.sha256 !== sha256) throw new Error('Revision already exists with different content; choose a new revision');
  if (fs.existsSync(destination)) {
    if (digest(readFile(file, 12 * 1024 * 1024)) !== sha256 || fs.readdirSync(destination).join(',') !== 'document.json') throw new Error('Revision directory already contains different content');
  } else {
    fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
    const staging = fs.mkdtempSync(path.join(root, '.publish-'));
    try { atomic(path.join(staging, 'document.json'), text); fs.renameSync(staging, destination); }
    finally { fs.rmSync(staging, {recursive: true, force: true}); }
  }
  if (!existing) registry.versions.push({id, label: `${manifest.productVersion} · ${id}`, version: manifest.productVersion, published_at: manifest.publishedAt, sha256});
  registry.current = id;
  atomic(index, JSON.stringify(registry, null, 2) + '\n');
  return {revision: id, sha256, guides: manifest.guides.length, unchanged: !!existing};
}
