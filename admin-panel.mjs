import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT, STATE, CONFIG, PYTHON} from './runtime.mjs';

// The browser selects only allowed actions and targets, never files or administrator identity.
export function createAdminPanel({contentRoot}) {
  const revisionKey = crypto.randomBytes(32).toString('hex');
  return {
    call(action, {signature, data, sharedPassword, resources} = {}) {
      const result = spawnSync(PYTHON, [path.join(ROOT, 'scripts/admin_panel.py'), action], {
        input: JSON.stringify({admin_signature: signature, data, shared_password: sharedPassword,
          resources, revision_key: revisionKey}), encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
        env: {...process.env, API_DOCS_STATE: STATE, API_DOCS_CONFIG: CONFIG, API_DOCS_CONTENT_ROOT: contentRoot, API_DOCS_NODE: process.execPath}
      });
      let value;
      try { if (!result.error && result.status === 0) value = JSON.parse(result.stdout); } catch {}
      if (!value) throw Object.assign(new Error('管理员操作未完成，请刷新面板检查状态。'), {status: 503});
      if (value.error) throw Object.assign(new Error(value.error), {status: value.status || 503});
      return value;
    }
  };
}
