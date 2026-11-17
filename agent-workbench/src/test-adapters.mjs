import { randomUUID } from 'node:crypto';
import { browserUrl, validateBrowserPlan } from '../examples/browser-lab/browser-actions.mjs';
import { parseBrowserObservation, parseBrowserReport, withoutReportLine } from './browser-report.mjs';

const OFFICE = new Set(['xlsx', 'docx']);
const SCRIPTS = new Set(['playwright', 'selenium']);
const FILE_LIMIT = 48;
const DIR_LIMIT = 18;
const READ_LINES = 160;
const READ_PAGES = 8;
const READ_CHARS = 38_000;
const PLAN_BYTES = 24_000;
const PLAN_TTL = 5 * 60_000;
const HASH = /^sha256:[a-f0-9]{64}$/;
const shellChars = /[;&|`$<>\r\n]/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = value => String(value ?? '').split('\n')[0].slice(0, 280);
const encoded = value => Buffer.from(value, 'utf8').toString('base64url');
const denied = message => { throw new Error(message); };
const publicFile = ({ sourceId, path, format, contentHash }) => ({ sourceId, path, format, ...(contentHash ? {contentHash} : {}) });

function reply(kind, fields, isError = false, summary = fields) {
  return { isError, structuredContent: { kind, ...fields }, content: [{ type: 'text', text: JSON.stringify({ kind, ...summary }) }] };
}
function relative(value) {
  if (value === '.') return value;
  if (typeof value !== 'string' || !value || value.length>420 || /[\\:\u0000-\u001f\u007f]/.test(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..')) denied('请提供已授权项目内的相对路径。');
  return value;
}
const inside = (scope, item) => scope === '.' || item === scope || item.startsWith(scope + '/');
const localJoin = (path, name) => relative(path === '.' ? name : path + '/' + name);
const formatFor = path => {
  const ext = path.split('.').at(-1)?.toLowerCase();
  if (['xlsx','docx','md'].includes(ext)) return ext;
  if (['js','mjs','cjs','ts','mts','cts'].includes(ext)) return 'playwright';
  if (ext === 'py') return 'selenium';
  return null;
};
const targetFor = value => {
  if (typeof value !== 'string' || Buffer.byteLength(value)>1800) denied('请选择完整的测试目标网址。');
  return browserUrl(value).href;
};
function structured(out, fallback) {
  if (out?.isError) {
    const code = out.structuredContent?.remoteCode ?? out.structuredContent?.code;
    const message = out.structuredContent?.message ?? out.content?.find(row=>row.type==='text')?.text;
    const error = new Error(message ? short(message) : fallback);
    error.toolCode = code;
    throw error;
  }
  if (!plain(out?.structuredContent)) denied(fallback);
  return out.structuredContent;
}
function matchesScope(root, path) { return !!root && inside(root, path); }
function baseCommand(projectId, fields) {
  return {projectId,...fields,cwd:'.',timeoutMs:30_000};
}
function scriptProof(stdout,stderr,exitCode,format,target) {
  const text = String(stdout ?? '');
  const marker = text.split(/\r?\n/).findLast(line => line.startsWith('NAVI_TEST_REPORT='));
  try {
    const row = JSON.parse(marker ? marker.slice('NAVI_TEST_REPORT='.length) : text);
    const stats = marker && row.version === 1 && row.framework === format
      ? { passed: row.passed, failed: row.failed, skipped: row.skipped ?? 0 }
      : format==='playwright' && plain(row.stats)
        ? { passed: row.stats.expected, failed: row.stats.unexpected + (row.stats.flaky ?? 0), skipped: row.stats.skipped ?? 0 }
        : null;
    if (stats && Object.values(stats).every(value => Number.isSafeInteger(value) && value>=0)) {
      let visited = false;
      try { visited = typeof row.visitedUrl === 'string' && browserUrl(row.visitedUrl).href === target; } catch {}
      return {status:exitCode!==0 || stats.failed>0 ? 'failed' : stats.passed>0 && visited ? 'passed' : 'unverified',tests:stats};
    }
  } catch {}
  if (format==='selenium') {
    const summary = text + '\n' + stderr;
    const count = Number(summary.match(/(?:^|\n)Ran (\d+) tests? in [^\n]+/)?.[1]);
    const skip = Number(summary.match(/(?:OK|FAILED) \([^\n]*skipped=(\d+)/)?.[1] ?? 0);
    if (Number.isSafeInteger(count) && count>skip &&
       /(?:^|\n)OK(?:\s*\([^\n]*\))?\s*(?:\n|$)/.test(summary) && exitCode===0) {
      return {status:'unverified',tests:{passed:count-skip,failed:0,skipped:skip}};
    }
  }
  return {status:exitCode===0 ? 'unverified' : 'failed'};
}

export function createTestAdapters({ sourceProject, owner, runId, targetUrl, sourceScope, signal, invoke, ensureLab }) {
  const target = targetFor(targetUrl);
  if (!sourceProject?.id || !owner || !runId || typeof invoke !== 'function') denied('测试上下文无效。');
  const files = new Map(), sourceByPath = new Map(), jobs = new Map();
  let observation = null;
  const scope = () => sourceScope?.path ? relative(sourceScope.path) : null;
  function assertScope(path) {
    if (!matchesScope(scope(), path)) denied('测试来源必须在这次核准的项目目录内。');
  }
  async function sourceTool(name,args) {
    signal?.throwIfAborted();
    assertScope(args.path);
    const out = await invoke(name,{projectId:sourceProject.id,...args},{purpose:'source-read'});
    const row = structured(out,'Nexus 未返回可验证的项目数据。');
    if (row.projectId !== undefined && row.projectId !== sourceProject.id) denied('Nexus 返回的项目不匹配。');
    return row;
  }
  function guarded(fn) {
    return async args => {
      try { signal?.throwIfAborted(); return await fn(args ?? {}); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (['EXECUTION_UNKNOWN','EXTENSION_BRIDGE_UNAUTHORIZED'].includes(error.code)) throw error;
        return reply('test.error',{ status:'blocked', message:short(error.message || '测试工具不可用。') },true);
      }
    };
  }
  function file(id) {
    const row = files.get(id);
    if (!row) denied('测试来源 ID 不属于本次发现。');
    assertScope(row.path);
    return row;
  }
  async function readPage(path, startLine, maxLines) {
    const row = await sourceTool('localbridge_file_read',{path,startLine,maxLines});
    if (!HASH.test(row.contentHash ?? '') || !Array.isArray(row.lines) ||
      row.path!==undefined && row.path!==path) denied('文件读取返回了无效的来源或哈希。');
    return row;
  }
  async function readBounded(path, format = null) {
    let line = 1, contentHash = null, chars = 0, truncated = false;
    const blocks = [], warnings = [];
    for (let page=0;page<READ_PAGES;page++) {
      let row;
      try { row = await readPage(path,line,READ_LINES); }
      catch (error) {
        if (OFFICE.has(format) && ['BINARY_FILE','RPC_REMOTE_ERROR'].includes(error.toolCode) && /binary file/i.test(error.message)) {
          denied('此 Runner 还不支持 Office 文本。请运行准备脚本并重启 Navi Runner。');
        }
        throw error;
      }
      if (OFFICE.has(format) && row.sourceFormat !== format) {
        denied('此 Runner 还不支持 Office 文本。请运行准备脚本并重启 Navi Runner。');
      }
      if (contentHash && row.contentHash !== contentHash) denied('文件在读取期间已变化，请重新读取。');
      contentHash=row.contentHash;
      for (const warning of row.sourceWarnings ?? []) if (typeof warning==='string' && warnings.length<5 && !warnings.includes(warning)) warnings.push(short(warning));
      for (const item of row.lines) {
        if (!Number.isInteger(item?.line) || item.line<line || typeof item.text !== 'string') denied('文件行号或内容无效。');
        const tab = OFFICE.has(format) ? item.text.indexOf('\t') : -1;
        if (OFFICE.has(format) && tab<1) denied('Office 文本缺少单元格或段落来源。');
        const text = tab<0 ? item.text : item.text.slice(tab+1);
        if (chars+text.length>READ_CHARS) { truncated=true; break; }
        blocks.push({ ref:tab < 0 ? 'L'+item.line : item.text.slice(0,tab), text });
        chars+=text.length;
      }
      if (row.sourceTruncated) truncated = true;
      if (truncated || row.nextLine === null || row.nextLine === undefined) break;
      if (!Number.isInteger(row.nextLine) || row.nextLine<=line || page===READ_PAGES-1) { truncated=true; break; }
      line=row.nextLine;
    }
    if (truncated) warnings.push('内容已截断，无法据此批准执行。请缩小来源或拆分文件。');
    return {contentHash,blocks,truncated,warnings};
  }
  const lab = async () => {
    if (typeof ensureLab !== 'function') denied('尚未准备 Navi 浏览器 Runner。');
    const project = await ensureLab();
    if (!project?.id || project.id === sourceProject.id) denied('没有独立且已授权的浏览器执行项目。');
    return project;
  };
  const labCommand = (projectId,extra) => baseCommand(projectId, {kind:'node-script',path:'browser-test.mjs',args:extra});
  const inspectCommand = projectId => labCommand(projectId,['--mode','inspect','--report-mode','runner','--url-base64',encoded(target)]);
  const dslCommand = (projectId,document) => {
    const serial = JSON.stringify(document);
    if (Buffer.byteLength(serial)>PLAN_BYTES) denied('浏览器计划超过 24 KB。');
    const parts = encoded(serial).match(/.{1,3000}/g) ?? [];
    return labCommand(projectId,['--report-mode','runner','--url-base64',encoded(target),...parts.flatMap(part=>['--plan-part',part])]);
  };
  async function scriptCommand(selected, runner) {
    const scriptText=selected.blocks.map(block=>block.text).join('\n');
    const references = selected.format==='playwright' ? /(?:['"](?:@playwright\/test|playwright(?:-core)?)['"]|\bplaywright\b)/i : /\b(?:from|import)\s+selenium\b/;
    if (!references.test(scriptText)) denied('未识别到此测试脚本的 Playwright 或 Selenium 框架。');
    if (sourceProject.executionMode !== 'project-code') denied('源项目未启用项目代码执行权限，请先在 Navi 核准。');
    if (shellChars.test(target)) denied('该目标网址含 Runner 脚本参数不接受的字符。');
    const identity = selected.path;
    if (runner === 'playwright-test') {
      if (selected.format!=='playwright' || scope()!=='.') {
        denied('TypeScript 或 Playwright Test 需要在项目根目录有受支持的现成测试启动脚本。');
      }
      const manifest=await readBounded('package.json');
      let pkg;
      try { pkg=JSON.parse(manifest.blocks.map(block=>block.text).join('\n')); } catch { denied('无法读取已授权项目的 package.json。'); }
      const manager = pkg?.packageManager ? /^((?:npm|pnpm|yarn|bun))@[0-9]/.exec(pkg.packageManager)?.[1] : 'npm';
      const launchers = Object.keys(pkg?.scripts ?? {}).filter(name => /^(?:navi:test|test:e2e|test:playwright|e2e|playwright)$/.test(name));
      if (!manager || launchers.length!==1) denied('必须能唯一确认项目的测试启动器和包管理器。');
      const script=launchers[0];
      const path=/^(?:node|tsx) ([\w./-]+\.(?:mjs|cjs|js|ts))$/.exec(pkg?.scripts?.[script] ?? '')?.[1];
      if (!path || manifest.truncated || pkg.scripts['pre'+script] || pkg.scripts['post'+script]) {
        denied('项目测试启动器须为已存在的单一 node/tsx 脚本，无 shell 串联或生命周期钩子。');
      }
      const launcher=await readBounded(relative(path.replace(/^\.\//,'')));
      if (launcher.truncated || !launcher.blocks.some(block=>block.text.includes('--url')) ||
        !launcher.blocks.some(block=>block.text.includes('--case'))) denied('测试启动器必须接受固定 --url 和 --case 参数。');
      return {command:baseCommand(sourceProject.id,{kind:'package-script',manager,script,args:['--url',target,'--case',identity]}),
        additional:[{path:'package.json',contentHash:manifest.contentHash},{path:relative(path.replace(/^\.\//,'')),contentHash:launcher.contentHash}]};
    }
    const kind=selected.format==='selenium' ? 'python-script' : 'node-script';
    if (runner && runner!==(kind==='python-script' ? 'python-selenium' : 'node-playwright')) denied('请选择与已发现脚本匹配的运行方式。');
    if (/\.(?:ts|mts|cts)$/i.test(identity) || /['"]@playwright\/test['"]/.test(scriptText)) {
      denied('此脚本需用已配置的 package-script 执行。');
    }
    if (!scriptText.includes('--url')) denied('已存在的测试脚本需接受固定的 --url 参数。');
    return {command:baseCommand(sourceProject.id,{kind,path:identity,args:['--url',target]}),additional:[]};
  }

  const discover = guarded(async ({path}) => {
    const root=relative(path);
    if (scope()!==root) denied('请使用本轮已批准的测试目录。');
    const queue=[{path:root,depth:0}];
    const found=[];
    let visited=0,truncated=false;
    while (queue.length && visited<DIR_LIMIT && found.length<FILE_LIMIT) {
      const current=queue.shift();
      const row=await sourceTool('localbridge_directory_list',{path:current.path});
      visited++;
      if (!Array.isArray(row.entries) || row.path!==undefined && row.path!==current.path) denied('目录读取结果无效。');
      if (row.nextCursor) truncated=true;
      for (const item of row.entries) {
        const name=item?.name;
        if (typeof name!=='string' || !name || name.startsWith('.') || /[\\/]/.test(name) || item.accessible===false) continue;
        const child=localJoin(current.path,name);
        if (item.type==='directory' && !['node_modules','vendor','dist','build','__pycache__'].includes(name)) {
          if (current.depth<3 && queue.length<DIR_LIMIT) queue.push({path:child,depth:current.depth+1});
          else truncated=true;
          continue;
        }
        const format=formatFor(child);
        if (item.type!=='file' || !format) continue;
        if (found.length>=FILE_LIMIT) {truncated=true;break;}
        let record=sourceByPath.get(child);
        if (!record) {
          record={sourceId:randomUUID(),path:child,format};
          files.set(record.sourceId,record);
          sourceByPath.set(child,record);
        }
        found.push(publicFile(record));
      }
    }
    return reply('test.discovery',{path:root,sources:found,truncated:truncated || queue.length>0});
  });
  const read = guarded(async ({sourceId}) => {
    const source=file(sourceId), data=await readBounded(source.path,source.format);
    Object.assign(source,data);
    return reply('test.source',{...publicFile(source),blocks:data.blocks,truncated:data.truncated,warnings:data.warnings});
  });
  const observe = guarded(async () => {
    if (!scope()) denied('请先核准并发现测试来源目录。');
    if (observation) return reply('test.observation',observation);
    const project=await lab();
    const result=await invoke('localbridge_command_run',inspectCommand(project.id),{purpose:'lab-harness'});
    if (result?.isError) structured(result,'无法连接测试浏览器。');
    const seen=parseBrowserObservation(result);
    if (!seen || seen.status!=='observed') denied(seen?.error || 'Runner 未返回已验证的页面观察。');
    if (new URL(seen.url).origin!==new URL(target).origin) denied('页面观察偏离了已批准目标。');
    observation={status:'observed',observationId:randomUUID(),url:seen.url,title:seen.title,controls:seen.controls,text:seen.text};
    return reply('test.observation',observation);
  });
  const plan = guarded(async ({sourceIds,mode,steps,runner}) => {
    if (!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>8||new Set(sourceIds).size!==sourceIds.length||
      !['document','script'].includes(mode)||jobs.size>=8) denied('请选择本次测试来源和执行方式。');
    const selected=sourceIds.map(file);
    if (selected.some(item=>!item.contentHash || item.truncated)) denied('先完整读取要执行的测试来源。');
    const sources=selected.map(publicFile);
    let command, approval, additional=[];
    if (mode==='document') {
      if (!observation) denied('文档用例须先观察目标网页，再提出可核对的操作。');
      if (selected.some(item=>SCRIPTS.has(item.format))) denied('浏览器步骤须引用本轮读取的文档用例。');
      const document=validateBrowserPlan({name:'Navi 文档测试用例',steps});
      if (browserUrl(document.steps[0].path).href!==target || document.steps.some(step=>step.action==='goto'&&browserUrl(step.path,target).origin!==new URL(target).origin)) {
        denied('测试导航必须从用户批准的目标开始，并保持同一来源。');
      }
      const project=await lab();
      command=dslCommand(project.id,document);
      approval={summary:'运行已审阅的浏览器步骤 · '+target,steps:document.steps,command};
    } else {
      if (selected.length!==1 || !SCRIPTS.has(selected[0].format) || steps!==undefined) denied('一次只运行一个已存在的测试脚本。');
      ({command,additional}=await scriptCommand(selected[0],runner));
      approval={summary:'运行已存在的 '+selected[0].format+' 项目脚本 · '+target,command};
    }
    const jobId=randomUUID(), requirements=[], expiresAt=Date.now()+PLAN_TTL;
    const frozen=structuredClone({jobId,owner,runId,projectId:sourceProject.id,mode,targetUrl:target,sources,approval,requirements,command,additional,expiresAt});
    jobs.set(jobId,{job:frozen,used:false});
    return reply('test.plan',{jobId,mode,targetUrl:target,sources,approval,requirements,expiresAt});
  });
  function getJob(jobId) {
    const record=jobs.get(jobId);
    if (!record || record.job.owner!==owner || record.job.runId!==runId || record.job.projectId!==sourceProject.id ||
      record.job.targetUrl!==target || record.job.expiresAt<=Date.now()) denied('测试计划不存在或已失效。');
    return record;
  }
  async function revalidate(jobId) {
    signal?.throwIfAborted();
    const {job}=getJob(jobId);
    if (job.mode==='document' && (await lab()).id!==job.command.projectId) denied('浏览器执行项目与本次计划不符。');
    for (const source of [...job.sources,...job.additional]) {
      const page=await readPage(source.path,1,1);
      if (page.contentHash!==source.contentHash) denied('来源有变更。请重新读取、生成计划并核准。');
    }
    return structuredClone({jobId,command:job.command,expiresAt:job.expiresAt});
  }
  const run = guarded(async ({jobId}) => {
    const record=getJob(jobId);
    if (record.used) denied('测试计划已经发出一次。');
    record.used=true;
    const job=record.job, startedAt=Date.now();
    const report = (status, fields = {}) => {
      const value={status,mode:job.mode,targetUrl:target,startedAt,finishedAt:Date.now(),sources:job.sources,...fields};
      return reply('test.report',{report:value},status!=='passed',{report:{...value,artifacts:value.artifacts?.map(({mime})=>({mime}))}});
    };
    try { await revalidate(jobId); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (['EXECUTION_UNKNOWN','EXTENSION_BRIDGE_UNAUTHORIZED'].includes(error.code)) throw error;
      return report('blocked',{message:short(error.message)});
    }
    let result;
    try {
      result=await invoke('localbridge_command_run',structuredClone(job.command),
        {purpose:job.mode==='document'?'lab-harness':'source-script'});
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (['EXECUTION_UNKNOWN','EXTENSION_BRIDGE_UNAUTHORIZED'].includes(error.code)) throw error;
      return report('unverified',{message:short(error.message || 'Runner 未确认执行结果；未重试。')});
    }
    if (result?.isError) {
      const row=result.structuredContent;
      const text=short(row?.message ?? result.content?.find(item=>item.type==='text')?.text);
      const notAvailable=/not found|no module named|cannot find|command blocked|permission|未授权|缺少|找不到/i.test(text) ||
        /(?:DISABLED|DENIED|NOT_FOUND|BLOCKED|APPROVAL_REQUIRED)/.test(row?.remoteCode ?? row?.code ?? '');
      return report(notAvailable ? 'blocked' : 'unverified',{message:text || 'Runner 未返回可验证结果。'});
    }
    if (job.mode==='document') {
      const parsed=parseBrowserReport(result,true);
      if (!parsed) return report('unverified',{message:'Runner 没有返回有效浏览器报告。'});
      const code=parsed.row.exitCode;
      const fields={steps:parsed.report.steps,exitCode:code,stdout:withoutReportLine(parsed.row.stdout).slice(0,3000),
        stderr:short(parsed.row.stderr), ...(parsed.image?{ artifacts:[{mime:'image/jpeg',base64:parsed.image.toString('base64')}] }: {})};
      return report(parsed.report.steps.some(step=>step.action==='setup'&&step.status==='failed') ? 'blocked' : parsed.report.status,fields);
    }
    const row = result?.structuredContent;
    if (!Number.isInteger(row?.exitCode)) return report('unverified',{message:'Runner 没有确认脚本退出状态。'});
    const stdout=String(row.stdout??'').slice(0,8000), stderr=String(row.stderr??'').slice(0,4000);
    if (row.timedOut) return report('unverified',{exitCode:row.exitCode,message:'运行超时；结果未确认。',stdout,stderr});
    if (/ERR_MODULE_NOT_FOUND|No module named|Executable doesn't exist|command not found|WebDriver.*not found/i.test(stderr+'\n'+stdout)) {
      return report('blocked',{exitCode:row.exitCode,message:'项目缺少已安装的测试依赖或浏览器驱动。',stdout,stderr});
    }
    const proof=scriptProof(row.stdout,row.stderr,row.exitCode,job.sources[0].format,target);
    return report(proof.status,{exitCode:row.exitCode,tests:proof.tests, stdout,stderr,
      ...(proof.status==='unverified'?{message:'脚本已退出，但未证明针对本次目标执行并通过断言，无法报告通过。'}:{})});
  });
  return {discover,read,observe,plan,run,revalidate};
}
