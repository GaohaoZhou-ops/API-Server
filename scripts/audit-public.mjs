/** Audit Git objects, not ignored working files. Never print matching secret values. */
import {execFileSync} from 'node:child_process';
import {scanText, parseJSON} from '../document-protocol.mjs';

const git = args => execFileSync('git', args, {maxBuffer: 32 * 1024 * 1024});
const failures = new Set(), inspected = new Set();
const forbidden = /(?:^|\/)(?:var|content|data|incoming|private|local-docs|releases|release-[^/]+|node_modules|\.cache|\.env(?:\..*)?)(?:\/|$)|\.(?:zip|tar|gz|tgz|7z|rar|sqlite\d*|db|pem|key|p12|pfx|eml|msg)$/i;
function allowedFiles(raw) {
  const values = parseJSON(raw);
  if (!Array.isArray(values) || values.some(item => typeof item !== 'string' || item.startsWith('/') || item.split('/').some(part => !part || part === '..') || forbidden.test(item)) || new Set(values).size !== values.length) throw new Error('Invalid .public-files.json');
  return new Set(values);
}
function inspect(file, oid, mode, allowed) {
  if (!allowed.has(file) || forbidden.test(file) || !['100644', '100755'].includes(mode) || (file.startsWith('config/') && !file.endsWith('.example'))) failures.add('Unapproved path or file type: ' + file);
  if (inspected.has(oid)) return;
  inspected.add(oid);
  const bytes = git(['cat-file', 'blob', oid]);
  if (file === 'public/fonts/noto-sans-sc.woff2') return;
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) { failures.add('Unexpected binary/oversized object: ' + file); return; }
  try { scanText(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { failures.add('Credential/text check failed: ' + file); }
}
function tree(commit) {
  const allowed = allowedFiles(git(['show', commit + ':.public-files.json']).toString());
  for (const entry of git(['ls-tree', '-rz', commit]).toString().split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t'), [mode, type, oid] = meta.split(' ');
    if (type !== 'blob') {failures.add('Non-file object: ' + file); continue;}
    inspect(file, oid, mode, allowed);
  }
}
try {
  const allowed = allowedFiles(git(['show', ':.public-files.json']).toString());
  for (const entry of git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t'), [mode, oid, stage] = meta.split(' ');
    if (stage !== '0') failures.add('Unresolved index: ' + file);
    else inspect(file, oid, mode, allowed);
  }
  if (process.argv.includes('--history')) for (const commit of git(['rev-list', '--all']).toString().trim().split('\n').filter(Boolean)) tree(commit);
  if (failures.size) { console.error([...failures].join('\n')); process.exitCode = 1; }
  else console.log(`Public repository audit passed: ${inspected.size} unique Git blobs; ${process.argv.includes('--history') ? 'index and reachable history' : 'index'}.`);
} catch { console.error('Public repository audit could not complete. Check Git staging and the explicit file manifest.'); process.exitCode = 1; }
