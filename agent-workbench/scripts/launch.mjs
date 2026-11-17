import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, RUNTIME, token, privateDir, privateWrite, readOrCreate, mustBeFree, pause, child } from './lib.mjs';
import { startWorkbench } from '../src/server.mjs';
import { Nexus } from '../src/nexus.mjs';
import { cprBaseUrl } from '../src/cpr.mjs';

const mode = process.argv[2] || 'local';
const privateKeys = resolve(RUNTIME, 'private');
const operatorFile = resolve(privateKeys, 'operator.key');
const cprSettingsFile = resolve(privateKeys, 'cpr-settings.json');
const cprDefault = 'http://127.0.0.1:8080/v1';
const services = [];
let workbench;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  workbench?.stopBrowserPreparation();
  workbench?.close();
  for (const proc of [...services].reverse()) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const proc of services) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
    process.exit(code);
  }, 2_500).unref();
}
function launch(path, loader, env, cwd) {
  const p = child(process.execPath, ['--import', loader, path], {
    cwd, env: { ...process.env, ...env }
  });
  services.push(p);
  p.once('error', e => { console.error(e.message); stop(1); });
  p.once('exit', (code, signal) => {
    if (!stopping) { console.error('Nexus 子进程退出：' + (code ?? signal)); stop(1); }
  });
}
async function waiting(label, attempt) {
  for (let i = 0; i < 75 && !stopping; i++) {
    try { const result = await attempt(); if (result) return result; } catch {}
    await pause(320);
  }
  throw new Error(label + ' 未就绪，请检查上方 Nexus 日志。');
}
const fileOrEmpty = async file => {
  try { return (await readFile(file, 'utf8')).trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
};
async function cprSettings() {
  const data = await fileOrEmpty(cprSettingsFile);
  if (!data) return { baseUrl:cprDefault, clientKey:'' };
  const saved = JSON.parse(data);
  return { baseUrl:cprBaseUrl(saved.baseUrl), clientKey:typeof saved.clientKey === 'string' ? saved.clientKey : '', defaultModel:saved.defaultModel || '' };
}
async function nexusServices() {
  const dir = resolve(RUNTIME, 'nexus');
  const dirSrc = resolve(RUNTIME, 'upstream/Nexus');
  // This fixed Nexus server bundle includes a CJS YAML dependency and fails under native ESM.
  // Run upstream entrypoints via its own locked tsx loader; no Nexus source changes are needed.
  const serverEntry = resolve(dirSrc, 'apps/server/src/index.ts');
  const runnerEntry = resolve(dirSrc, 'apps/runner/src/index.ts');
  const serverLoader = resolve(dirSrc, 'apps/server/node_modules/tsx/dist/loader.mjs');
  const runnerLoader = resolve(dirSrc, 'apps/runner/node_modules/tsx/dist/loader.mjs');
  try { await Promise.all([access(serverLoader), access(runnerLoader), access(resolve(dirSrc, 'packages/protocol/dist/index.js'))]); }
  catch { throw new Error('请先执行 npm run prepare:nexus。'); }
  await mustBeFree(18080);
  await privateDir(dir);
  const mgmt = await readOrCreate(resolve(privateKeys, 'nexus-management.key'), () => token('lm_'));
  const runner = await readOrCreate(resolve(privateKeys, 'nexus-runner.key'), () => token('lbr_'));
  // Give only the Nexus child processes a private application home. Nexus has
  // upstream components that resolve state with os.homedir().
  const isolatedHome = resolve(dir, 'process-home');
  await privateDir(isolatedHome);
  const nexusEnv = { HOME: isolatedHome, USERPROFILE: isolatedHome, LOCALAPPDATA: isolatedHome };
  const serverConfig = resolve(dir, 'server.json');
  const runnerConfig = resolve(dir, 'runner.json');
  await privateWrite(serverConfig, JSON.stringify({ server: { host: '127.0.0.1', port: 18080, dbPath: resolve(dir, 'nexus.db') }, logging: { level: 'warn' } }, null, 2));
  await privateWrite(runnerConfig, JSON.stringify({
    serverUrl: 'ws://127.0.0.1:18080/runner/ws', runnerName: 'Workbench Local Runner',
    statePath: resolve(dir, 'runner-id.json'), projectsPath: resolve(dir, 'projects.json'),
    logging: { level: 'warn' }
  }, null, 2));
  launch(serverEntry, serverLoader, {
    ...nexusEnv, LOCALBRIDGE_CONFIG: serverConfig, LOCALBRIDGE_SERVER_HOST: '127.0.0.1', LOCALBRIDGE_SERVER_PORT: '18080',
    LOCALBRIDGE_SERVER_DB_PATH: resolve(dir, 'nexus.db'), LOCALBRIDGE_MANAGEMENT_TOKEN: mgmt,
    LOCALBRIDGE_REQUIRE_MGMT_AUTH: 'true', LOCALBRIDGE_BOOTSTRAP_RUNNER_TOKEN: runner, NEXUS_DISABLE_INTERNAL_GATEWAY: 'true'
  }, dir);
  await waiting('Nexus 核心', async () => {
    const res = await fetch('http://127.0.0.1:18080/health', { signal: AbortSignal.timeout(1000) });
    return res.ok;
  });
  const url = 'http://127.0.0.1:18080/mcp';
  const keyFile = resolve(privateKeys, 'nexus-workbench-mcp.key');
  let localKey = await fileOrEmpty(keyFile);
  if (!localKey) {
    const result = await new Nexus({ url, managementToken: mgmt }).manage('/api/tokens', {
      method: 'POST', body: { name: 'Navi', type: 'mcp', scopes: ['read', 'write', 'execute'] }
    });
    if (!result.token?.startsWith('lb_')) throw new Error('无法初始化工作台工具令牌。');
    localKey = result.token;
    await privateWrite(keyFile, localKey + '\n');
  }
  launch(runnerEntry, runnerLoader, {
    ...nexusEnv, LOCALBRIDGE_RUNNER_CONFIG: runnerConfig, LOCALBRIDGE_SERVER_URL: 'ws://127.0.0.1:18080/runner/ws',
    LOCALBRIDGE_RUNNER_TOKEN: runner, LOCALBRIDGE_RUNNER_NAME: 'Workbench Local Runner',
    LOCALBRIDGE_PROJECTS_PATH: resolve(dir, 'projects.json')
  }, dir);
  const nexus = new Nexus({ url, token: localKey, managementToken: mgmt });
  await waiting('Nexus Runner', async () => (await nexus.runners(AbortSignal.timeout(1500))).length > 0);
  const project = resolve(RUNTIME, 'sandbox');
  await privateDir(project);
  try {
    await writeFile(resolve(project, 'README.md'),
      '# Navi 示例项目\n\n这是本地 Runner 能读取的私有示例目录。你可以在项目页注册并测试读取。\n',
      { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  console.log('Nexus + Runner 已就绪。示例目录：' + project);
  return { nexusUrl: url, nexusToken: localKey, managementToken: mgmt, sandboxPath: project,
    browserLabPath: resolve(ROOT, 'examples/browser-lab') };
}

try {
  if (+process.versions.node.split('.')[0] < 24) throw new Error('需要 Node.js 24 或更高版本。');
  await privateDir(RUNTIME);
  await privateDir(privateKeys);
  const operatorToken = await readOrCreate(operatorFile, () => token('wb_'));
  if (mode === 'operator') {
    // Explicit opt-in display of this local operator credential. Upstream credentials are never printed.
    console.log(operatorToken);
  } else if (mode === 'import-key') {
    // Use stdin to keep the client key out of shell history and process arguments.
    if (process.stdin.isTTY) throw new Error('请从隐蔽输入或权限为 0600 的文件经标准输入导入 CPR Client Key，参见 README。');
    let cprKey = '';
    for await (const chunk of process.stdin) {
      cprKey += chunk;
      if (cprKey.length > 2_048) throw new Error('Client Key 长度超限。');
    }
    cprKey = cprKey.trim();
    if (cprKey.length < 8 || !/^[\x21-\x7e]+$/.test(cprKey)) throw new Error('Client Key 格式无效。');
    await privateWrite(cprSettingsFile, JSON.stringify({baseUrl:(await cprSettings()).baseUrl,clientKey:cprKey})+'\n');
    console.log('CPR Client Key 已保存。重启工作台后生效。');
  } else if (['demo', 'model-demo', 'local', 'desktop'].includes(mode)) {
    await mustBeFree(17880);
    process.on('SIGINT', () => stop());
    process.on('SIGTERM', () => stop());
    const cpr = ['local', 'desktop'].includes(mode) ? await cprSettings() : {baseUrl:cprDefault,clientKey:''};
    const initialMode = mode === 'desktop' ? (cpr.clientKey ? 'local' : 'model-demo') : mode;
    const base = { operatorToken, mode:initialMode, desktopExample:mode === 'desktop' && !cpr.clientKey,
      cprUrl:cpr.baseUrl, cprKey:cpr.clientKey, nexusUrl:'http://127.0.0.1:18080/mcp' };
    const config = {
      ...base, ...(mode === 'demo' ? {} : await nexusServices()),
      defaultModel: cpr.defaultModel || await fileOrEmpty(resolve(RUNTIME, 'model.' + initialMode + '.txt'))
    };
    workbench = await startWorkbench(config);
    if (mode !== 'desktop') console.log('使用 npm run --silent operator 查看本机工作台操作员密钥。');
  } else throw new Error('未知启动模式。');
} catch (error) {
  console.error(error.message);
  stop(1);
  process.exitCode = 1;
}
