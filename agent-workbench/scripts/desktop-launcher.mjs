// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { hasCurrentOfficePatch } from './apply-nexus-office.mjs';

const WORKBENCH = fileURLToPath(new URL('../', import.meta.url));
const HOST = '127.0.0.1';
const PORT = 17880;
const BASE = `http://${HOST}:${PORT}`;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TICKET_DURATION = 60_000;
const PROBE_TIMEOUT = 1200;
const SERVICE_TIMEOUT = 55_000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const OWNER_CHECK = typeof process.getuid === 'function' ? process.getuid() : null;
const nonce = () => randomBytes(32).toString('base64url');

class DesktopError extends Error {}

async function makePrivateDir(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || (OWNER_CHECK !== null && info.uid !== OWNER_CHECK)) {
    throw new DesktopError('启动所需的本机目录不是当前用户拥有的目录。');
  }
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

async function checkPrivateFile(fileHandle) {
  const info = await fileHandle.stat();
  if (!info.isFile() || info.nlink !== 1 || (OWNER_CHECK !== null && info.uid !== OWNER_CHECK)) {
    throw new DesktopError('发现非普通本机文件，Navi未将其用于启动。');
  }
  if ((info.mode & 0o777) !== 0o600) await fileHandle.chmod(0o600);
  return info;
}

export async function getOrCreateInstanceKey(privateDir) {
  const file = join(privateDir, 'launch-instance.key');
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    await handle.writeFile(nonce() + '\n');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await handle?.close();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const reader = await open(file, constants.O_RDONLY | O_NOFOLLOW);
    try {
      const info = await checkPrivateFile(reader);
      if (info.size > 64) throw new DesktopError('工作台归属校验文件格式无效。');
      const key = (await reader.readFile('utf8')).trim();
      if (TICKET_PATTERN.test(key)) return key;
      if (key) break;
    } finally { await reader.close(); }
    await sleep(30);
  }
  throw new DesktopError('工作台归属校验文件格式无效。');
}

export async function issueTicket(privateDir, now = Date.now()) {
  const ticket = nonce();
  const hash = createHash('sha256').update(ticket).digest('hex');
  const file = join(privateDir, 'launch-ticket.json');
  const temporary = join(privateDir, '.launch-ticket-' + randomBytes(8).toString('hex') + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify({ hash, expiresAt: now + TICKET_DURATION }) + '\n',
      { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return BASE + '/#login-ticket=' + ticket;
}

export function checkSignature(payload, key, challenge) {
  if (payload?.product !== 'qizhou-workbench' || typeof payload.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.signature) || !TICKET_PATTERN.test(key) ||
      !TICKET_PATTERN.test(challenge)) return false;
  const signature = Buffer.from(payload.signature, 'hex');
  const expected = createHmac('sha256', key).update(challenge).digest();
  return timingSafeEqual(signature, expected);
}

// Direct IPv4 HTTP, no proxy environment or redirect handling. Only the
// random challenge crosses the wire. HTTP success alone grants no trust.
export function probeInstance(key, transport = request) {
  const challenge = nonce();
  return new Promise((resolveProbe, rejectProbe) => {
    let timer;
    const finish = result => {
      clearTimeout(timer);
      resolveProbe(result);
    };
    const req = transport({
      protocol: 'http:', hostname: HOST, port: PORT, agent: false,
      path: '/api/instance?nonce=' + challenge, method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    }, res => {
      if (res.statusCode !== 200) {
        finish('foreign');
        res.destroy();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 1024) { finish('foreign'); res.destroy(); }
      });
      res.on('end', () => {
        try { finish(checkSignature(JSON.parse(body), key, challenge) ? 'ready' : 'foreign'); }
        catch { finish('foreign'); }
      });
      res.on('error', () => finish('foreign'));
    });
    req.once('error', error => {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        clearTimeout(timer);
        rejectProbe(new DesktopError('当前环境不允许连接本机工作台 ' + HOST + ':' + PORT + '（' + error.code + '）。请在允许本机回环网络的环境启动。', { cause: error }));
      } else finish(error.code === 'ECONNREFUSED' ? 'absent' : 'foreign');
    });
    timer = setTimeout(() => {
      finish('foreign');
      req.destroy();
    }, PROBE_TIMEOUT);
    req.end();
  });
}

function pathExists(file) { return access(file).then(() => true, () => false); }

function childEnvironment() {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'BASH_ENV', 'ENV', 'ZDOTDIR']) delete env[name];
  env.PATH = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  env.GIT_TERMINAL_PROMPT = '0';
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  return env;
}

async function appendHandle(file) {
  const descriptor = await open(file, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | O_NOFOLLOW, 0o600);
  try { await checkPrivateFile(descriptor); return descriptor; }
  catch (error) { await descriptor.close(); throw error; }
}

function commandExit(proc) {
  return new Promise((resolveExit, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function runHidden(command, args) {
  const result = await commandExit(spawn(command, args, { stdio: 'ignore', env: childEnvironment() }));
  if (result.code !== 0) throw new DesktopError('macOS 未能打开指定的本机界面。');
}

export async function needsPreparation(runtime) {
  const nexus = join(runtime, 'upstream', 'Nexus');
  const dependencies = [
    'apps/server/src/index.ts', 'apps/runner/src/index.ts',
    'apps/server/node_modules/tsx/dist/loader.mjs', 'apps/runner/node_modules/tsx/dist/loader.mjs',
    'packages/protocol/dist/index.js',
  ];
  const ready = (await Promise.all(dependencies.map(name => pathExists(join(nexus, name))))).every(Boolean);
  return !ready || !await hasCurrentOfficePatch(nexus);
}

async function runPrepare(workbench, log) {
  await log.write(`\n[${new Date().toISOString()}] 正在准备锁定版本的 Nexus 依赖。\n`);
  const processOptions = { cwd: workbench, stdio: ['ignore', log.fd, log.fd], env: childEnvironment() };
  const proc = spawn(process.execPath, [join(workbench, 'scripts', 'prepare.mjs'), 'nexus'], processOptions);
  const timer = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  }, 15 * 60_000);
  try {
    const { code } = await commandExit(proc);
    if (code !== 0) throw new DesktopError('Nexus 组件准备未完成。检查网络连接；详情在启动日志中。');
  } finally { clearTimeout(timer); }
}

async function startDaemon(workbench, logfile) {
  const handle = await appendHandle(logfile);
  try {
    await handle.write(`\n[${new Date().toISOString()}] 启动Navi。\n`);
    const proc = spawn(process.execPath, [join(workbench, 'scripts', 'launch.mjs'), 'desktop'], {
      cwd: workbench, env: childEnvironment(), detached: true, stdio: ['ignore', handle.fd, handle.fd],
    });
    const outcome = { done: false };
    proc.once('exit', (code, signal) => Object.assign(outcome, { done: true, code, signal }));
    await new Promise((resolveSpawn, reject) => { proc.once('spawn', resolveSpawn); proc.once('error', reject); });
    proc.unref();
    return outcome;
  } finally { await handle.close(); }
}

function stillRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function lockOwner(lock) {
  try { return JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function claimLaunch(lock) {
  const owner = { pid: process.pid, id: randomBytes(12).toString('hex') };
  const ownerPath = join(lock, 'owner.json');
  const deadline = Date.now() + 800;
  async function forget() {
    const current = await lockOwner(lock);
    if (current?.id === owner.id) {
      await rm(ownerPath, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  while (Date.now() <= deadline) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try { await writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return forget;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(lock).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) continue;
      if (!info.isDirectory() || (OWNER_CHECK !== null && info.uid !== OWNER_CHECK)) {
        throw new DesktopError('Navi无法创建本机启动锁。');
      }
      const old = await lockOwner(lock);
      if ((old && !stillRunning(old.pid)) || (!old && Date.now() - info.mtimeMs >= 10_000)) {
        const newer = await lstat(lock).catch(() => null);
        const current = await lockOwner(lock);
        if (newer?.ino === info.ino && current?.id === old?.id) {
          const retired = lock + '.' + owner.id;
          try { await rename(lock, retired); await rm(retired, { recursive: true, force: true }); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      } else if (old && stillRunning(old.pid)) return null;
      else await sleep(100);
    }
  }
  return null;
}

function rejectForeign() {
  throw new DesktopError('本机端口 17880 已被占用，但无法验证为这份Navi。请先关闭旧版Navi或处理端口占用，再双击启动。');
}

export async function ensureWorkbench({ probe, prepare, launch, deadline = SERVICE_TIMEOUT }) {
  let state = await probe();
  if (state === 'ready') return 'reused';
  if (state !== 'absent') rejectForeign();
  await prepare();
  state = await probe();
  if (state === 'ready') return 'reused';
  if (state !== 'absent') rejectForeign();
  const outcome = await launch();
  const until = Date.now() + deadline;
  do {
    state = await probe();
    if (state === 'ready') return 'started';
    if (state !== 'absent') rejectForeign();
    if (outcome.done) throw new DesktopError('Navi启动失败。详情在工作台日志中。');
    await sleep(350);
  } while (Date.now() < until);
  throw new DesktopError('Navi未在预期时间内就绪。详情在工作台日志中。');
}

const failureScript = `on run argv
  set messageText to item 1 of argv
  set logPath to item 2 of argv
  if logPath is "" then
    display dialog messageText with title "Navi" buttons {"好"} default button "好" with icon caution
    return
  end if
  set choice to button returned of (display dialog messageText with title "Navi" buttons {"查看日志", "好"} default button "好" with icon caution)
  if choice is "查看日志" then
    do shell script "/usr/bin/open -t " & quoted form of logPath
  end if
end run`;

async function showSetupNotice() {
  try {
    await runHidden('/usr/bin/osascript', ['-e',
      'display notification "首次准备 Nexus 组件，完成后会自动打开浏览器。" with title "Navi"']);
  } catch {}
}

async function waitForTicket(privateDir) {
  const path = join(privateDir, 'launch-ticket.json');
  const end = Date.now() + TICKET_DURATION;
  while (Date.now() < end && await pathExists(path)) await sleep(300);
}

export async function desktopMain() {
  const runtime = join(WORKBENCH, '.runtime');
  const privateDir = join(runtime, 'private');
  const logs = join(runtime, 'desktop');
  const launchLog = join(logs, 'launch.log');
  const workbenchLog = join(logs, 'workbench.log');
  let log;
  let release;
  try {
    if (process.platform !== 'darwin') throw new DesktopError('Navi.app 需要 macOS。');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new DesktopError('Navi需要 Node.js 24 或更高版本。');
    if (!await pathExists(join(WORKBENCH, 'scripts', 'launch.mjs'))) throw new DesktopError('找不到套件内的工作台启动脚本。');
    await makePrivateDir(runtime);
    await makePrivateDir(privateDir);
    await makePrivateDir(logs);
    release = await claimLaunch(join(logs, 'launch.lock'));
    if (!release) return; // Another Finder request is preparing or opening the browser.
    log = await appendHandle(launchLog);
    await log.write(`\n[${new Date().toISOString()}] Navi.app 启动检查。\n`);
    const key = await getOrCreateInstanceKey(privateDir);
    const state = await ensureWorkbench({
      probe: () => probeInstance(key),
      prepare: async () => {
        if (!await needsPreparation(runtime)) return;
        void showSetupNotice();
        await runPrepare(WORKBENCH, log);
      },
      launch: () => startDaemon(WORKBENCH, workbenchLog),
    });
    await log.write(state === 'reused' ? '已核验并复用本机工作台。\n' : '已核验新启动的本机工作台。\n');
    const url = await issueTicket(privateDir);
    try {
      await runHidden('/usr/bin/open', [url]);
    } catch {
      await rm(join(privateDir, 'launch-ticket.json'), { force: true });
      throw new DesktopError('工作台已就绪，但 macOS 未能打开默认浏览器。请检查默认浏览器设置。');
    }
    await log.write('已请求打开默认浏览器。\n');
    await waitForTicket(privateDir);
  } catch (error) {
    const message = error instanceof DesktopError ? error.message : '无法启动Navi。请查看本机启动日志。';
    try { await log?.write(`[${new Date().toISOString()}] ${error?.code ?? ''} ${message}\n`); } catch {}
    const logfile = await pathExists(workbenchLog) && message.includes('工作台日志') ? workbenchLog :
      await pathExists(launchLog) ? launchLog : '';
    if (process.platform === 'darwin') {
      try { await runHidden('/usr/bin/osascript', ['-e', failureScript, message, logfile]); } catch {}
    } else console.error(message);
    process.exitCode = 1;
  } finally {
    try { await log?.close(); } catch {}
    try { await release?.(); } catch {}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await desktopMain();
