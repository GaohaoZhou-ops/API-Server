// Private IPC: all credential material travels through stdin/stdout, never argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function key(file, create) {
  if (create && !fs.existsSync(file)) {
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { fs.rmSync(temporary, {force: true}); }
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size !== 32 || (info.mode & 0o077)) throw new Error();
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!['seal', 'open'].includes(input.action) || typeof input.value !== 'string' || input.value.length > 4096 || typeof input.binding !== 'string') throw new Error();
  const secret = key(input.key_file, input.action === 'seal' && input.create_key === true);
  const binding = Buffer.from(input.binding, 'utf8');
  let value;
  if (input.action === 'seal') {
    const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(binding);
    const encrypted = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
    value = 'v1.' + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  } else {
    if (!input.value.startsWith('v1.')) throw new Error();
    const bytes = Buffer.from(input.value.slice(3), 'base64');
    if (bytes.length < 29) throw new Error();
    const cipher = crypto.createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
    cipher.setAAD(binding); cipher.setAuthTag(bytes.subarray(12, 28));
    value = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
  secret.fill(0);
  process.stdout.write(JSON.stringify({value}));
} catch {
  process.stderr.write('Credential vault unavailable.\n');
  process.exitCode = 1;
}
