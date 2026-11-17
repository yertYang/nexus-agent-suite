import { access, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { browserSocketReady } from './browser-probe.mjs';
import { ROOT, RUNTIME, privateDir, privateWrite, run, pause } from './lib.mjs';

const lab = resolve(ROOT,'examples/browser-lab');
const config = resolve(RUNTIME,'private/browser-playwright.json');
const image = 'mcr.microsoft.com/playwright@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48';
const container = 'qizhou-workbench-browser';
const ownerLabel = 'qizhou.workbench.browser';
const browserPort = 36415;
const dock = (args) => execFileSync('docker',args,{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}).trim();
function owner() {
  try { return dock(['inspect','--format','{{index .Config.Labels "'+ownerLabel+'"}}',container]) === 'isolated-fixture'; }
  catch { return null; }
}
async function setup() {
  await privateDir(RUNTIME);
  await run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{
    cwd:lab,env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH,npm_config_cache:resolve(RUNTIME,'npm-cache')}
  });
}
try {
  const cmd = process.argv[2] || 'prepare';
  if (cmd === 'prepare') await setup();
  else if (cmd === 'up') {
    try { await access(resolve(lab,'node_modules/playwright-core/package.json')); } catch { await setup(); }
    await privateDir(RUNTIME); await privateDir(dirname(config));
    const ownership = owner();
    if (ownership === false) throw new Error('发现同名容器，未复用。');
    if (!ownership) {
      await run('docker',['run','-d','--init','--name',container,'--label',ownerLabel+'=isolated-fixture',
        '--add-host','host.docker.internal:host-gateway','--publish','127.0.0.1::'+browserPort,
        '--shm-size=256m','--mount','type=bind,src='+lab+',dst=/lab,readonly',image,'node','/lab/browser-service.mjs']);
    } else if (dock(['inspect','--format','{{.State.Running}}',container]) !== 'true') {
      await run('docker',['start',container]);
    }
    let current;
    for (let i=0;i<40&&!current;i++) {
      try {
        const endpoint = dock(['logs','--tail','35',container]).split('\n')
          .findLast(line=>line.startsWith('QIZHOU_BROWSER_ENDPOINT='))?.slice('QIZHOU_BROWSER_ENDPOINT='.length);
        const binding = dock(['port',container,browserPort+'/tcp']);
        if (endpoint && /^127\.0\.0\.1:\d+$/.test(binding)) {
          const ws = new URL(endpoint); ws.host=binding;
          if (await browserSocketReady(ws.href,400)) current=ws.href;
        }
      } catch {}
      if (!current) await pause(300);
    }
    if (!current) throw new Error('隔离 Chromium 未就绪；请检查 Docker 容器。');
    await privateWrite(config,JSON.stringify({wsEndpoint:current,fixtureHost:'host.docker.internal'})+'\n');
    console.log('隔离 Chromium 已就绪。其连接信息存于工作台私有目录。');
  } else if (cmd === 'down') {
    if (owner()) await run('docker',['rm','-f',container]);
    await rm(config,{force:true});
  } else throw new Error('未知浏览器运行命令。');
} catch(error) { console.error(error.message); process.exitCode=1; }
