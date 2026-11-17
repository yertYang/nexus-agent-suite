import { createHash, randomBytes } from 'node:crypto';
import { access, readFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyOfficePatch } from './apply-nexus-office.mjs';
import { ROOT, RUNTIME, privateDir, privateWrite, run, mustBeFree } from './lib.mjs';

const lock = JSON.parse(await readFile(resolve(ROOT, 'vendor/LOCK.json')));
const nexusSource = resolve(RUNTIME, 'upstream/Nexus');
const cprDir = resolve(RUNTIME, 'cpr/deploy');
const exists = p => access(p).then(() => true, () => false);
const selected = process.argv[2];
const env = { ...process.env };

async function prepareNexus() {
  if (+process.versions.node.split('.')[0] < 24) throw new Error('需要 Node.js 24 或更高版本。');
  await privateDir(dirname(nexusSource));
  if (!(await exists(resolve(nexusSource, 'package.json')))) {
    const vendoredSource = resolve(ROOT, 'vendor/source/Nexus.tar.gz');
    if (await exists(vendoredSource)) {
      const sum = createHash('sha256').update(await readFile(vendoredSource)).digest('hex');
      if (sum !== lock.nexus.archiveSha256) throw new Error('Nexus vendor 快照校验失败。');
      await privateDir(nexusSource);
      await run('tar', ['-xzf', vendoredSource, '-C', nexusSource]);
      await privateWrite(resolve(nexusSource, '.workbench-revision'), lock.nexus.revision);
    } else {
      await privateDir(nexusSource);
      await run('git', ['init', '--quiet'], { cwd: nexusSource });
      await run('git', ['fetch', '--quiet', '--depth', '1', lock.nexus.url, lock.nexus.revision], { cwd: nexusSource });
      await run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: nexusSource });
    }
  }
  const revision = (await exists(resolve(nexusSource, '.workbench-revision')))
    ? (await readFile(resolve(nexusSource, '.workbench-revision'), 'utf8')).trim()
    : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: nexusSource, encoding: 'utf8' }).trim();
  if (revision !== lock.nexus.revision) throw new Error('本地 Nexus 源码与锁定版本不匹配。');
  await applyOfficePatch(nexusSource, revision);
  const nodeBin = dirname(process.execPath);
  const nodePrefix = dirname(nodeBin);
  Object.assign(env, { PATH: nodeBin + ':' + env.PATH, COREPACK_HOME: resolve(RUNTIME, 'corepack'), npm_config_devdir: resolve(RUNTIME, 'node-gyp') });
  if (await exists(resolve(nodePrefix, 'include/node/common.gypi'))) env.npm_config_nodedir = nodePrefix;
  const pm = ['pnpm@' + lock.nexus.pnpm, '--filter', '@localbridge/server...', '--filter', '@localbridge/runner...'];
  await run('corepack', [...pm, '--store-dir', resolve(RUNTIME, 'pnpm-store'), 'install', '--frozen-lockfile'], { cwd: nexusSource, env });
  await run('corepack', [...pm, 'run', 'build'], { cwd: nexusSource, env });
}
async function prepareCpr() {
  await privateDir(cprDir);
  for (const [name, digest] of Object.entries(lock.codexProxyRs.assets)) {
    const source = resolve(ROOT, 'vendor/cpr-v3.49.0', name);
    const sum = createHash('sha256').update(await readFile(source)).digest('hex');
    if (sum !== digest) throw new Error(name + ' 与锁定的 CPR 发布资产不符。');
    await copyFile(source, resolve(cprDir, name));
  }
  await copyFile(resolve(ROOT, 'vendor/cpr-v3.49.0/local.compose.yaml'), resolve(cprDir, 'local.compose.yaml'));
  const configPath = resolve(cprDir, 'config.yaml');
  if (!(await exists(configPath))) {
    const raw = await readFile(resolve(cprDir, 'config.example.yaml'), 'utf8');
    await privateWrite(configPath, raw
      .replace("password: &postgres_password ''", "password: &postgres_password '" + randomBytes(24).toString('hex') + "'")
      .replace("password: &redis_password ''", "password: &redis_password '" + randomBytes(24).toString('hex') + "'")
      .replace("default_password: ''", "default_password: '" + randomBytes(18).toString('base64url') + "'"));
  }
}
try {
  await privateDir(RUNTIME);
  if (selected === 'nexus') await prepareNexus();
  else if (selected === 'cpr') await prepareCpr();
  else if (selected === 'cpr-up' || selected === 'cpr-down') {
    await prepareCpr();
    const args = ['compose', '-p', 'nexus-workbench-cpr', '-f', 'compose.yaml', '-f', 'local.compose.yaml'];
    const options = { cwd: cprDir, env: { ...env, CPR_IMAGE: lock.codexProxyRs.image } };
    if (selected === 'cpr-up') {
      const running = execFileSync('docker', [...args, 'ps', '--status', 'running', '--quiet', 'codex-proxy-rs'], { ...options, encoding: 'utf8' }).trim();
      if (!running) await mustBeFree(8080);
      await run('docker', [...args, 'config', '--quiet'], options);
      await run('docker', [...args, 'up', '--no-build', '-d', '--wait', '--wait-timeout', '180'], options);
      console.log('CPR: http://127.0.0.1:8080 · 配置位于 .runtime/cpr/deploy/config.yaml');
    } else await run('docker', [...args, 'down'], options);
  } else throw new Error('未知准备命令。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
