import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPackage, validateBundle, validateOpenAPI, parseJSON} from '../document-protocol.mjs';
import {publish, readPublication, readRegistry} from '../publications.mjs';
import {publicDocs} from '../public-docs.mjs';
import {renderMarkdown} from '../web/markdown.mjs';

const example = fileURLToPath(new URL('../examples/hello-docs', import.meta.url));
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-protocol-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return root; }
function fixture(t) {const root = path.join(temporary(t), 'package'); fs.cpSync(example, root, {recursive: true}); return root;}
function change(root, fn) { const file = path.join(root, 'docs.json'), value = JSON.parse(fs.readFileSync(file)); fn(value); fs.writeFileSync(file, JSON.stringify(value)); }

test('example builds an isolated publication with only declared documents', t => {
  const bundle = loadPackage(example), output = path.join(temporary(t), 'content');
  const result = publish(bundle, output);
  assert.equal(result.revision, '1.0.0');
  assert.deepEqual(fs.readdirSync(path.join(output, 'versions/1.0.0')), ['document.json']);
  const data = publicDocs({bundle: readPublication(output, '1.0.0'), versions: readRegistry(output)});
  assert.equal(data.catalog.length, 1); assert.equal(data.site.guides.length, 2);
  assert.equal(data.spec.paths['/status'].get.operationId, 'getStatus');
  assert.equal('sha256' in data.versions.versions[0], false);
});
for (const filename of ['implementation.py', 'source.cpp', 'business.zip', '.env', '.git/config', 'guides/private.md', 'dist/app.js', 'screenshots/image.png']) {
  test('rejects unexpected package file: ' + filename, t => {
    const root = fixture(t), file = path.join(root, filename); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'excluded');
    assert.throws(() => loadPackage(root), /unexpected/);
  });
}
for (const [label, mutation] of [
  ['private visibility', m => m.visibility = 'private'],
  ['unknown protocol', m => m.protocol = 'api-docs/v9'],
  ['unknown metadata', m => m.sourceRoot = '../business'],
  ['path traversal', m => m.guides[0].file = '../secret.md'],
  ['absolute path', m => m.guides[0].file = '/tmp/secret.md'],
  ['executable extension', m => m.guides[0].file = 'guides/run.py'],
  ['revision traversal', m => m.revision = '..'],
  ['reserved route', m => m.guides[0].id = 'admin'],
  ['duplicate id', m => m.guides[1].id = m.guides[0].id],
  ['duplicate path', m => m.guides[1].file = m.guides[0].file],
  ['timestamp without timezone', m => m.publishedAt = '2026-10-30'],
  ['URL OpenAPI import', m => m.openapi = 'https://example.com/openapi.json']
]) test('fails closed on ' + label, t => {const root = fixture(t); change(root, mutation); assert.throws(() => loadPackage(root), /rejected/);});
test('rejects file, directory, root symlinks and hard links', t => {
  const root = fixture(t), file = path.join(root, 'guides/quickstart.md'), secret = path.join(temporary(t), 'secret.md'); fs.writeFileSync(secret, 'private');
  fs.rmSync(file); fs.symlinkSync(secret, file); assert.throws(() => loadPackage(root), /unexpected|symbolic/);
  fs.rmSync(file); fs.linkSync(secret, file); assert.throws(() => loadPackage(root), /hard link/);
  fs.rmSync(path.join(root, 'guides'), {recursive: true}); fs.symlinkSync(path.dirname(secret), path.join(root, 'guides')); assert.throws(() => loadPackage(root), /unexpected/);
  const alias = path.join(temporary(t), 'alias'); fs.symlinkSync(example, alias); assert.throws(() => loadPackage(alias), /symbolic/);
});
test('blocks missing, oversized, binary and obvious credential content', t => {
  const root = fixture(t), file = path.join(root, 'guides/quickstart.md');
  for (const text of ['x'.repeat(512 * 1024 + 1), 'a\0b', '-----BEGIN ' + 'PRIVATE KEY-----\nexample', 'ghp_' + 'a'.repeat(36)]) {
    fs.writeFileSync(file, text); assert.throws(() => loadPackage(root));
  }
  fs.rmSync(file); assert.throws(() => loadPackage(root), /missing/);
});
for (const [label, mutation] of [
  ['unreviewed operation', s => delete s.paths['/status'].get['x-audience']],
  ['internal operation', s => s.paths['/status'].get['x-audience'] = 'internal'],
  ['source extension', s => s.paths['/status'].get['x-source'] = 'private.py'],
  ['external ref', s => s.components.schemas.Status.$ref = '../source.json'],
  ['URL ref', s => s.components.schemas.Status.$ref = 'https://example.com/source.json'],
  ['missing ref', s => s.components.schemas.Status.$ref = '#/components/schemas/Missing'],
  ['unknown schema keyword', s => s.components.schemas.Status.implementation = 'private'],
  ['external example file', s => s.components.examples = {bad: {externalValue: 'file:///etc/passwd'}}],
  ['URL credentials', s => s.servers[0].url = 'https://user:secret@example.com'],
  ['unknown component group', s => s.components.sources = {private: 'hidden'}],
  ['duplicate operation ids', s => s.paths['/other'] = structuredClone(s.paths['/status'])]
]) test('OpenAPI rejects ' + label, () => {const spec = structuredClone(loadPackage(example).openapi); mutation(spec); assert.throws(() => validateOpenAPI(spec), /rejected/);});
test('supports Markdown-only packages and rejects undeclared compiled data', t => {
  const root = fixture(t); change(root, m => delete m.openapi); fs.rmSync(path.join(root, 'openapi.json'));
  const bundle = loadPackage(root); assert.equal(bundle.openapi, null);
  assert.throws(() => validateBundle({...bundle, source: 'private'}));
  bundle.markdown.hidden = 'private'; assert.throws(() => validateBundle(bundle));
});
test('immutable revisions, idempotent retry, new revisions and integrity checks', t => {
  const bundle = loadPackage(example), root = path.join(temporary(t), 'content'); publish(bundle, root);
  assert.equal(publish(bundle, root).unchanged, true);
  const changed = structuredClone(bundle); changed.markdown.quickstart += '\nUpdate';
  assert.throws(() => publish(changed, root), /already exists/);
  assert.deepEqual(readPublication(root, '1.0.0'), bundle);
  changed.manifest.revision = '1.0.1'; publish(changed, root); assert.equal(readRegistry(root).current, '1.0.1');
  fs.appendFileSync(path.join(root, 'versions/1.0.1/document.json'), ' ');
  assert.throws(() => readPublication(root, '1.0.1'), /integrity/);
});
test('failed package validation leaves active revision intact and output symlinks are rejected', t => {
  const root = path.join(temporary(t), 'content'), bundle = loadPackage(example); publish(bundle, root);
  bundle.manifest.revision = '1.0.1'; bundle.extra = 'private'; assert.throws(() => publish(bundle, root));
  assert.equal(readRegistry(root).current, '1.0.0'); delete bundle.extra;
  fs.symlinkSync(temporary(t), path.join(root, 'versions/1.0.1')); assert.throws(() => publish(bundle, root), /symbolic/);
});
test('rejects prototype keys, deep JSON and private data in registry fields', () => {
  assert.throws(() => parseJSON('{"visibility":"private","visibility":"public"}'), /duplicate/);
  assert.throws(() => parseJSON('{"__proto__": {"x": 1}}'), /unsafe/);
  assert.throws(() => parseJSON('['.repeat(42) + '0' + ']'.repeat(42)), /nesting/);
});
test('Markdown renders escaped HTML, inert script links and local navigation without external images', () => {
  const result = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![secret](https://example.com/track)\n\n[Next](authentication.md)\n\n```js\nconst x = "<img>";\n```', {guides: [{id: 'authentication', file: 'guides/authentication.md'}], current: 'quickstart'});
  assert.doesNotMatch(result.html, /<script|<img|href="javascript:/);
  assert.match(result.html, /href="#authentication"/); assert.equal(result.codeBlocks.length, 1);
});
