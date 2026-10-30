import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT, STATE, PYTHON} from '../runtime.mjs';
import {loadPackage} from '../document-protocol.mjs';
import {publish} from '../publications.mjs';

async function main() {
  const [command, directory, ...extra] = process.argv.slice(2);
  if (!['check', 'publish'].includes(command) || !directory || extra.length) throw new Error('Usage: node scripts/docs.mjs check|publish /path/to/document-package');
  const bundle = loadPackage(directory);
  if (command === 'check') { console.log(`Valid ${bundle.protocol} package: ${bundle.manifest.revision}, ${bundle.manifest.guides.length} guides`); return; }
  const child = spawn(PYTHON, [path.join(ROOT, 'scripts/runtime.py'), 'lock', 'admin-panel'], {env: {...process.env, API_DOCS_STATE: STATE}, stdio: ['pipe', 'pipe', 'ignore']});
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => {child.kill(); reject(new Error('Publication lock timed out'));}, 10000);
      child.once('error', reject); child.once('exit', () => reject(new Error('Another publication or administrator operation is in progress')));
      child.stdout.once('data', resolve);
    });
    clearTimeout(timer);
    console.log(JSON.stringify(publish(bundle, process.env.API_DOCS_CONTENT_ROOT || path.join(ROOT, 'var/content')), null, 2));
  } finally { clearTimeout(timer); child.stdin.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
