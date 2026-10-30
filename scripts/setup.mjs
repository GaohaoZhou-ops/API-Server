import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT, STATE, CONFIG, PYTHON} from '../runtime.mjs';

const command = process.argv[2] || 'setup';
if (!['setup', 'credentials'].includes(command) || process.argv.length > 3) {
  console.error('Usage: npm run setup | npm run credentials'); process.exit(2);
}
const env = {...process.env, API_DOCS_CONFIG: CONFIG, API_DOCS_STATE: STATE, API_DOCS_NODE: process.execPath};
const result = spawnSync(PYTHON, [path.join(ROOT, 'scripts/setup.py'), command], {env, stdio: 'inherit'});
if (result.error || result.status !== 0) { console.error('Setup failed. Install Python 3.10+ and requirements.txt; set API_DOCS_PYTHON for a virtual environment.'); process.exit(1); }
if (command === 'setup') {
  const content = process.env.API_DOCS_CONTENT_ROOT || path.join(ROOT, 'var/content');
  if (!fs.existsSync(path.join(content, 'versions.json'))) {
    const publish = spawnSync(process.execPath, [path.join(ROOT, 'scripts/docs.mjs'), 'publish', path.join(ROOT, 'examples/hello-docs')], {env, stdio: 'inherit'});
    if (publish.error || publish.status !== 0) process.exit(1);
  }
  console.log('Ready. Run npm run credentials locally to view credentials, then npm start. Default URL: http://127.0.0.1:8787');
}
