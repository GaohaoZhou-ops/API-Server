import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function validPassword(value) {
  return typeof value === 'string' && [...value].length >= 16 && [...value].length <= 128 && !/[\r\n\0]/.test(value);
}

// This is a filesystem-protected Unix socket, never an HTTP/TCP endpoint.
export async function startPasswordAdmin({state, config, changePassword}) {
  const socketPath = path.join(state, 'admin.sock');
  try {
    const old = fs.lstatSync(socketPath);
    if (!old.isSocket()) throw new Error('管理员通道路径不是套接字');
    fs.unlinkSync(socketPath); // Safe after the caller has acquired the web singleton lock.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let queue = Promise.resolve();
  const clients = new Set();
  const server = net.createServer(socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {}); socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy());
    let input = '', handled = false;
    const reply = result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n'); };
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > 8192) { handled = true; reply({ok: false, error: '请求过大'}); return; }
      if (!input.includes('\n')) return;
      handled = true;
      let message;
      try { message = JSON.parse(input); }
      catch { reply({ok: false, error: '请求格式无效'}); return; }
      if (!message || message.command !== 'change-password'
          || message.pid !== process.pid || message.config !== path.resolve(config)) {
        reply({ok: false, error: '服务实例或配置不匹配，请重试'}); return;
      }
      const password = message.mode === 'generate' ? crypto.randomBytes(24).toString('base64url') : message.mode === 'set' ? message.password : null;
      if (!validPassword(password)) { reply({ok: false, error: '密码须为 16 至 128 个字符，不能包含换行或空字符'}); return; }
      queue = queue.then(async () => {
        try {
          const result = await changePassword(password);
          reply({ok: true, ...result});
        } catch { reply({ok: false, error: '改密失败，请检查服务状态和配置文件权限'}); }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); resolve(); }
      catch (error) { server.close(); reject(error); }
    });
  });
  return {close() { for (const client of clients) client.destroy(); server.close(); }};
}
