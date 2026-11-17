import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { access, readFile, realpath, mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserUrl, executeBrowserStep, roles, validateBrowserPlan } from './browser-actions.mjs';

const root = await realpath(dirname(fileURLToPath(import.meta.url)));
const argumentsMap = new Map();
let browser, context, server, page;
let report, screenshot, observation, inspect = false;
let totalTimer;
const allowedArguments = new Set(['--case','--url','--url-base64','--plan-part','--allow-origin','--browser','--report-mode','--mode']);
function inside(path) { const r = relative(root, path); return r && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') && !isAbsolute(r); }
const logSafeUrl = value => {
  const url = new URL(value); url.search = ''; url.hash = ''; return url.href;
};
const shortError = error => String(error?.message || error).replace(/wss?:\/\/[^\s]+/g,'[浏览器连接]').split('\n')[0].slice(0, 170);
async function localFixture(remoteHost) {
  const html = await readFile(resolve(root,'fixture.html'));
  server = createServer((req,res) => {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store',
      'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'" });
    res.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve); });
  return new URL('http://' + (remoteHost || '127.0.0.1') + ':' + server.address().port + '/');
}
async function browserPath() {
  let configured;
  try { configured = JSON.parse(await readFile(resolve(root,'browser.local.json'),'utf8')).executablePath; }
  catch(error) { if (error.code !== 'ENOENT') throw error; }
  const config = argumentsMap.get('--browser')?.[0] || configured;
  const possibilities = config ? [config] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ];
  for (const executablePath of possibilities) {
    if (typeof executablePath !== 'string' || !isAbsolute(executablePath)) continue;
    try { await access(executablePath); return executablePath; } catch {}
  }
  if (config) throw new Error('配置的 Chromium 路径不可用。');
  return undefined; // installed Playwright Chromium if available
}
async function close() {
  const outstanding = Promise.allSettled([
    context?.close().catch(() => {}),
    new Promise(resolve => { if (server?.listening) { server.close(resolve); server.closeAllConnections(); } else resolve(); })
  ]);
  let timer;
  await Promise.race([outstanding,new Promise(resolve => { timer=setTimeout(resolve,1250); })]); clearTimeout(timer);
  if (browser) await browser.close().catch(() => {});
}
async function capture() {
  if (!page || page.isClosed()) throw new Error('页面已关闭，没有截图。');
  for (const quality of [25,16,10]) {
    const bytes = await page.screenshot({type:'jpeg',quality,timeout:2_500,animations:'disabled'});
    if (bytes.length <= 21_000) { screenshot = bytes; return; }
  }
  throw new Error('截图超过大小限制，没有保存。');
}
const rawArgs = process.argv.slice(2);
// The requested output channel still applies when command validation fails.
function outputOption(flag) {
  for (let i=0;i<rawArgs.length;i+=2) {
    if (rawArgs[i] === flag) return rawArgs[i+1];
  }
}
const requestedMode = outputOption('--mode');
const runnerReport = outputOption('--report-mode') === 'runner';
function caseArgs(a) {
  if (a.length > 36 || a.length % 2) throw new Error('命令参数无效。');
  for (let i=0;i<a.length;i+=2) {
    const part = a[i] === '--plan-part', limit = part || a[i] === '--url-base64' ? 3_000 : 2_048;
    if (!allowedArguments.has(a[i]) || a[i+1].length > limit ||
      !['--allow-origin','--plan-part'].includes(a[i]) && argumentsMap.has(a[i])) {
      throw new Error('不支持的参数或重复参数。');
    }
    argumentsMap.set(a[i],[...(argumentsMap.get(a[i]) ?? []),a[i+1]]);
  }
}
function fromBase64url(value, limit) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('用例数据编码无效。');
  const decoded=Buffer.from(value,'base64url');
  if (decoded.length>limit || decoded.toString('base64url')!==value) throw new Error('用例数据过大或编码无效。');
  return new TextDecoder('utf-8',{fatal:true}).decode(decoded);
}
async function loadCase() {
  const parts=argumentsMap.get('--plan-part');
  if (parts) {
    if (argumentsMap.has('--case') || parts.length>12 || !argumentsMap.has('--url-base64') ||
      argumentsMap.has('--allow-origin') || argumentsMap.has('--browser')) {
      throw new Error('内联用例只允许使用固定目标网址。');
    }
    return validateBrowserPlan(JSON.parse(fromBase64url(parts.join(''),24_000)));
  }
  const arg = argumentsMap.get('--case')?.[0] ?? 'case.example.json';
  if (isAbsolute(arg)) throw new Error('用例路径必须相对于已授权项目。');
  const casePath = await realpath(resolve(root,arg));
  if (!inside(casePath) || (await stat(casePath)).size > 40_000) throw new Error('用例超出项目边界或太大。');
  return validateBrowserPlan(JSON.parse(await readFile(casePath,'utf8')));
}
async function observePage(page,base,origins) {
  await executeBrowserStep({page,base,origins},{action:'goto',path:base.href});
  const view=await page.evaluate(knownRoles=>{
    const normalize=(value,max)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
    const visible=element=>{
      const style=getComputedStyle(element);
      return element.getClientRects().length>0&&style.display!=='none'&&style.visibility==='visible'&&
        !element.closest('[aria-hidden="true"],[inert]');
    };
    const impliedRole=el=>{
      if (el instanceof HTMLInputElement) {
        const type=el.type;
        if (['checkbox','radio','search','number'].includes(type)) return {search:'searchbox',number:'spinbutton'}[type]||type;
        if (['button','submit','reset'].includes(type)) return 'button';
        return ['text','email','tel','url','password'].includes(type)?'textbox':null;
      }
      if (el instanceof HTMLSelectElement) return el.multiple||el.size>1?'listbox':'combobox';
      return {BUTTON:'button',A:'link',TEXTAREA:'textbox',SUMMARY:'button',OPTION:'option'}[el.tagName]||
        (/^H[1-6]$/.test(el.tagName)?'heading':null);
    };
    const relevant=document.querySelectorAll('button,a[href],input,textarea,select,summary,h1,h2,h3,[role],[data-testid]');
    const controls=[];
    for (const element of relevant) {
      const role=element.getAttribute('role')?.split(/\s+/).find(name=>knownRoles.includes(name))||impliedRole(element);
      if (!knownRoles.includes(role)||!visible(element)) continue;
      const fromIds=element.getAttribute('aria-labelledby')?.split(/\s+/)
        .map(id=>document.getElementById(id)?.innerText??'').join(' ');
      const label=normalize(Array.from(element.labels??[],value=>{
        const clone=value.cloneNode(true);
        for (const control of clone.querySelectorAll('button,input,select,textarea')) control.remove();
        return clone.textContent;
      }).join(' '),90);
      const name=normalize(fromIds||element.getAttribute('aria-label')||label||
        (role==='button'&&element instanceof HTMLInputElement ? element.value :
          ['button','link','heading','tab','menuitem','option'].includes(role) ? element.innerText : ''),90);
      controls.push({role,name,label,testId:normalize(element.getAttribute('data-testid'),60)});
      if (controls.length===18) break;
    }
    return { title:normalize(document.title,130),text:normalize(document.body?.innerText,1400),controls };
  },roles);
  return {version:1,status:'observed',url:logSafeUrl(page.url()),...view};
}
const started = Date.now();
inspect = requestedMode !== undefined;
try {
  caseArgs(rawArgs);
  if (argumentsMap.has('--report-mode') && argumentsMap.get('--report-mode')[0] !== 'runner') throw new Error('报告模式无效。');
  if (argumentsMap.has('--mode')) {
    if (argumentsMap.get('--mode')[0]!=='inspect'||argumentsMap.has('--case')||argumentsMap.has('--plan-part')||argumentsMap.has('--allow-origin')) {
      throw new Error('观察只接受单一目标网页。');
    }
  }
  const testCase = inspect ? null : await loadCase();
  const encodedUrl=argumentsMap.get('--url-base64')?.[0];
  if (encodedUrl && argumentsMap.has('--url')) throw new Error('只能提供一个目标网址。');
  const specified = encodedUrl ? fromBase64url(encodedUrl,2048) : argumentsMap.get('--url')?.[0];
  let remote;
  if (!argumentsMap.has('--browser')) {
    try { remote = JSON.parse(await readFile(resolve(root,'../../.runtime/private/browser-playwright.json'),'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (remote && (!/^ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/.test(remote.wsEndpoint) || remote.fixtureHost !== 'host.docker.internal')) {
    throw new Error('隔离 Chromium 的本机连接参数无效。');
  }
  const base = specified ? browserUrl(specified) : await localFixture(remote?.fixtureHost);
  const origins = new Set([base.origin]);
  for (const entry of argumentsMap.get('--allow-origin') ?? []) origins.add(browserUrl(entry).origin);
  if (!inspect) report = { version:1,name:testCase.name,status:'passed',url:logSafeUrl(base.href),steps:[],durationMs:0 };
  // A local watchdog closes any browser context we own before the Runner timeout.
  totalTimer = setTimeout(() => { void close(); }, 24_000);
  browser = remote ? await chromium.connect(remote.wsEndpoint,{timeout:8_000}) :
    await chromium.launch({headless:true, executablePath:await browserPath(),timeout:9_000,
      args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
  context = await browser.newContext({viewport:{width:720,height:480},deviceScaleFactor:1,serviceWorkers:'block',
    acceptDownloads:false, permissions:[]});
  await context.route('**/*', async route => {
    try {
      const request=route.request();
      if (!origins.has(browserUrl(request.url()).origin)||inspect&&!['GET','HEAD'].includes(request.method())) return await route.abort('blockedbyclient');
      // Playwright's normal route handler is only guaranteed on the first URL in a
      // redirect chain. Fetch without following redirects, then block any 3xx Location.
      const response = await route.fetch({maxRedirects:0,timeout:4_000});
      if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
        await response.dispose();
        return await route.abort('blockedbyclient');
      }
      await route.fulfill({response});
      await response.dispose();
    } catch { await route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.routeWebSocket('**/*', ws => ws.close());
  page = await context.newPage();
  if (inspect) observation=await observePage(page,base,origins);
  else {
    for (const step of testCase.steps) {
      const before = Date.now();
      try {
        await executeBrowserStep({page,base,origins,capture},step);
        report.steps.push({action:step.action,status:'passed',durationMs:Date.now()-before});
      } catch (error) {
        report.steps.push({action:step.action,status:'failed',durationMs:Date.now()-before,error:shortError(error)});
        report.status = 'failed'; break;
      }
    }
    if (!screenshot && page.url() !== 'about:blank') await capture().catch(error=>{report.screenshotNote=shortError(error);});
    if (!screenshot && !report.screenshotNote) report.screenshotNote = '页面尚未加载，无截图。';
  }
} catch (error) {
  if (inspect) observation={version:1,status:'failed',error:shortError(error)};
  else {
    report ??= {version:1,name:'浏览器任务',status:'failed',url:'',steps:[],durationMs:0};
    report.status = 'failed';
    report.steps.push({action:'setup',status:'failed',durationMs:Date.now()-started,error:shortError(error)});
  }
} finally {
  clearTimeout(totalTimer);
  await close();
}
if (inspect) {
  console.log('NEXUS_BROWSER_OBSERVATION='+JSON.stringify(observation));
  process.exitCode=observation.status==='observed'||runnerReport?0:1;
} else {
  report.durationMs = Date.now() - started;
  try {
    const output = resolve(root,'.nexus-test-output');
    await mkdir(output,{recursive:true,mode:0o700});
    if (!inside(await realpath(output)) || await realpath(output) !== output) throw new Error('报告目录不能是符号链接。');
    const folder = await mkdtemp(resolve(output,'case-'));
    if (screenshot) await writeFile(resolve(folder,'screenshot.jpg'),screenshot,{mode:0o600,flag:'wx'});
    await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  } catch (error) {
    console.error('报告文件未写入：' + shortError(error));
  }
  console.log('NEXUS_BROWSER_REPORT='+JSON.stringify({
    ...report, ...(screenshot ? {screenshot:{mime:'image/jpeg',base64:screenshot.toString('base64')}} : {})
  }));
  // Nexus verifies process exit separately and drops stdout when the script exits
  // nonzero. Under Runner, the transport completed if a complete report was emitted;
  // the Workbench still marks any failed test and assertion as a failed tool result.
  process.exitCode = report.status === 'passed' || runnerReport ? 0 : 1;
}
