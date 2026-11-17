import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const RUNTIME = resolve(ROOT, '.runtime');
export const token = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function privateDir(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
export async function privateWrite(path, contents) {
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
export async function readOrCreate(path, create) {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await privateDir(dirname(path));
    try { await writeFile(path, create(), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    return (await readFile(path, 'utf8')).trim();
  }
}
export async function mustBeFree(port) {
  const srv = createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', error => {
      const address = '127.0.0.1:' + port;
      let message;
      if (error.code === 'EADDRINUSE') message = address + ' 已被占用，未接管现有进程。';
      else if (error.code === 'EPERM' || error.code === 'EACCES') message = '当前环境不允许监听 ' + address + '（' + error.code + '）。请在允许本机回环网络的环境启动。';
      else return reject(error);
      reject(Object.assign(new Error(message, { cause: error }), { code: error.code }));
    });
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise(resolve => srv.close(resolve));
}
export function child(command, args, options = {}) {
  return spawn(command, args, { cwd: ROOT, env: process.env, stdio: 'inherit', ...options });
}
export async function run(command, args, options = {}) {
  const proc = child(command, args, options);
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(command + ' 退出：' + (code ?? signal))));
  });
}
