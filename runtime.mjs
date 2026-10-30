import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const STATE = process.env.API_DOCS_STATE || path.join(ROOT, 'var/state');
const requestedConfig = path.resolve(process.env.API_DOCS_CONFIG || path.join(ROOT, 'var/config'));
export const CONFIG = requestedConfig;
export const PYTHON = process.env.API_DOCS_PYTHON || '/usr/bin/python3';
export const HELPER = path.join(ROOT, 'scripts', 'runtime.py');

export function readAccessPassword() {
  // Private IPC: capture helper output without echoing it or using command arguments.
  const result = spawnSync(PYTHON, [HELPER, 'access-password'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 16384,
    env: {...process.env, API_DOCS_STATE: STATE, API_DOCS_CONFIG: CONFIG}
  });
  if (result.error || result.status !== 0) throw new Error('无法读取访问密码配置；未自动更换密码。');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('访问密码配置不可读；未自动更换密码。'); }
}

export function updateConfig(patch, owner) {
  const result = spawnSync(PYTHON, [HELPER, 'update'], {
    input: JSON.stringify({patch, owner}), encoding: 'utf8', timeout: 15000,
    env: {...process.env, API_DOCS_STATE: STATE, API_DOCS_CONFIG: CONFIG}
  });
  if (result.error || result.status !== 0) throw new Error('无法更新访问配置 ' + CONFIG);
}

export async function singleton(role) {
  fs.mkdirSync(STATE, {recursive: true, mode: 0o700});
  fs.chmodSync(STATE, 0o700);
  const child = spawn(PYTHON, [HELPER, 'lock', role], {
    env: {...process.env, API_DOCS_STATE: STATE}, stdio: ['pipe', 'pipe', 'pipe']
  });
  let acquired = false;
  let releasing = false;
  child.on('exit', () => {
    if (acquired && !releasing) {
      console.error(`${role} 进程锁丢失，服务退出。`);
      process.exit(1);
    }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('获取进程锁超时')); }, 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (!acquired) reject(Object.assign(new Error(`${role} 已有实例或无法获取进程锁`), {exitCode: code || 1}));
    });
    child.stdout.once('data', () => { clearTimeout(timeout); acquired = true; resolve(); });
  });
  // The pipe is retained for this process's entire lifetime, including shutdown.
  process.on('exit', () => { releasing = true; child.stdin.end(); });
}
