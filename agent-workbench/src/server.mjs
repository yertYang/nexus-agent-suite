import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { AppError, cleanCode, cleanMessage, parseBody, signalWith, textOutput, wireFetch } from './net.mjs';
import { Cpr, cprBaseUrl } from './cpr.mjs';
import { Nexus, projectView } from './nexus.mjs';
import { RunManager } from './runs.mjs';
import { DemoNexus, DemoModel } from './demo.mjs';
import { BrowserPreparation, ensureBrowserProject, targetUrl } from './web-task.mjs';
import { createExtensionPairing, EXTENSION_ORIGIN, EXTENSION_MCP } from './extension-pair.mjs';
import { createBridgeGrants, redactBridge } from './extension-bridge.mjs';
import { ROOT, RUNTIME, privateWrite } from '../scripts/lib.mjs';
import { DeploymentManager } from './deployments.mjs';

const PORT = 17880;
const HOST = '127.0.0.1:' + PORT;
const ORIGIN = 'http://' + HOST;
const bridgeBase='/api/extension/bridge/';
const bridgeRequestId=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const bridgeRunPath=/^\/api\/extension\/bridge\/runs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(read|events\/read|decisions|cancel|browser\/claim|browser\/result)$/;
const bridgeArtifactPath=/^\/api\/extension\/bridge\/runs\/([a-f0-9-]{36})\/artifacts\/([a-f0-9-]{36})\/read$/;
const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'], '/ui/tokens.css': ['ui/tokens.css', 'text/css'],
  '/ui/reply.js': ['ui/reply.js', 'text/javascript'], '/ui/marked.js': ['ui/marked.js', 'text/javascript'],
  '/ui/components.css': ['ui/components.css', 'text/css'], '/ui/chevron-down.svg': ['ui/chevron-down.svg', 'image/svg+xml'] };
const digest = value => createHash('sha256').update(value).digest();
const opaque = () => randomBytes(32).toString('base64url');
const twelveHours = 12 * 3600_000;
const desktopExamplePrompt = '填写姓名 Ada，点击提交，确认出现 Hello Ada，并截图。';
const json = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
};
function extensionCors(req,res,methods,bearer=false) {
  if (req.headers.origin!==EXTENSION_ORIGIN || req.headers.cookie || (!bearer && req.headers.authorization)) {
    throw new AppError('拒绝此扩展来源。',403,'ORIGIN_DENIED');
  }
  const allowed=bearer ? ['content-type','authorization'] : ['content-type'];
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Origin',EXTENSION_ORIGIN);
  if (req.method!=='OPTIONS') return false;
  const requested=(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
  if (!methods.includes(req.headers['access-control-request-method']) || requested.some(value=>!allowed.includes(value))) {
    throw new AppError('不支持此扩展请求。',403,'ORIGIN_DENIED');
  }
  res.setHeader('Access-Control-Allow-Methods',methods.join(', ')+', OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',bearer?'Content-Type, Authorization':'Content-Type');
  res.writeHead(204).end();
  return true;
}
function routeId(value) {
  if (!/^[\w:-]{1,160}$/.test(value)) throw new AppError('标识格式无效。');
  return value;
}
async function health(url) {
  try {
    const response = await wireFetch(url, { signal: signalWith(undefined, 2_500) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
function cursorQuery(query) {
  const raw = query.get('cursor');
  const limit = Number(query.get('limit') ?? 10);
  if (raw && raw.length > 240 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new AppError('分页参数无效。');
  }
  return { ...(raw ? { cursor: raw } : {}), limit };
}
function safeProjectPath(value) {
  return typeof value === 'string' && value.length < 2_048 && path.isAbsolute(value.trim())
    && path.normalize(value.trim()) !== path.parse(value.trim()).root && !value.includes('\x00');
}
async function projectsWithPermission(nexus, route, id, changes) {
  const current = (await nexus.projects()).find(p => p.id === id);
  if (!current) throw new AppError('项目不存在或未启用。', 404);
  const { accessMode, executionMode } = changes;
  if (!['read-only', 'read-write'].includes(accessMode)
    || !['disabled', 'safe-only', 'project-code'].includes(executionMode)
    || (accessMode === 'read-only' && executionMode !== 'disabled')) {
    throw new AppError('只读项目需要关闭命令执行。');
  }
  const method = 'POST';
  const base = route + '/' + encodeURIComponent(id);
  if (executionMode === 'disabled' && current.executionMode !== 'disabled') {
    await nexus.manage(base + '/execution', { method, body: { executionMode } });
  }
  if (accessMode !== current.accessMode) await nexus.manage(base + '/access', { method, body: { accessMode } });
  if (executionMode !== 'disabled' && current.executionMode !== executionMode) {
    await nexus.manage(base + '/execution', { method, body: { executionMode } });
  }
  const saved = (await nexus.projects()).find(p => p.id === id);
  if (!saved || saved.accessMode !== accessMode || saved.executionMode !== executionMode) {
    throw new AppError('已送出更新，但未能核对最终权限，请刷新项目后检查。', 409, 'PERMISSION_READBACK');
  }
  return saved;
}

export function createWorkbench(config, opts = {}) {
  const demo = config.mode === 'demo';
  const deployments = new DeploymentManager({
    file: opts.noPersist || demo ? null : path.join(RUNTIME, 'private', 'deployments.json'),
    enabled: !demo, ...opts.deployments
  });
  let mode = config.mode, modelDemo = mode !== 'local';
  let modelClient = opts.modelClient ?? (modelDemo ? new DemoModel() : new Cpr({ url: config.cprUrl, key: config.cprKey }));
  const nexus = opts.nexus ?? (demo ? new DemoNexus() : new Nexus({
    url: config.nexusUrl, token: config.nexusToken, managementToken: config.managementToken
  }));
  const secrets = [config.cprKey, config.nexusToken, config.managementToken, config.operatorToken];
  const clean = value => cleanMessage(value, secrets);
  const testAdapters=opts.testAdapters ?? (demo ? undefined : async inputs=>{
    const {createTestAdapters}=await import('./test-adapters.mjs');
    return createTestAdapters(inputs);
  });
  const ensureTestLab=opts.ensureTestLab ?? (async signal=>{
    let status=await browserPrep.status();
    if (!status.ready && status.state!=='unavailable') {
      browserPrep.begin();
      for (;;) {
        signal.throwIfAborted();
        status=await browserPrep.status();
        if (status.ready || status.state!=='preparing') break;
        await delay(650,undefined,{signal});
      }
    }
    signal.throwIfAborted();
    if (!status.ready) throw new AppError(status.message || '隔离浏览器暂不可用。请安装 Chromium 或打开 Docker Desktop 后重试。',409,'TEST_BROWSER_UNAVAILABLE');
    return ensureBrowserProject(nexus,config.browserLabPath,
      (id,changes)=>projectsWithPermission(nexus,projectBase,routeId(id),changes));
  });
  const runs = new RunManager({ nexus, modelClient, secrets, testAdapters, ensureTestLab });
  const sessions = new Map();
  let failures = [];
  let defaultModel = config.defaultModel || '';
  let editingConnection = false;
  let activeCprUrl = config.cprUrl;
  const ticketFile = opts.ticketFile ?? path.join(RUNTIME,'private','launch-ticket.json');
  const instanceFile = opts.instanceFile ?? path.join(RUNTIME,'private','launch-instance.key');
  let consumingTicket = false;
  const operatorMarker = /^[A-Za-z0-9_-]{43}$/;
  const openSession = res => {
    const id = opaque(), csrf = opaque();
    for (const [k,val] of sessions) if (val.expiresAt < Date.now() || sessions.size >= 32) sessions.delete(k);
    sessions.set(id,{csrf,expiresAt:Date.now()+twelveHours});
    res.setHeader('Set-Cookie','nexus_operator='+id+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200');
    return json(res,200,{csrf});
  };
  const projectBase = '/api/management/projects';
  const browserPrep=new BrowserPreparation(config.browserLabPath);
  const bridgeGrants=createBridgeGrants();
  const pairing=createExtensionPairing({ nexus,origin:ORIGIN,enabled:!demo && config.nexusUrl===EXTENSION_MCP,issueBridge:bridgeGrants.issue });
  let preparingTask=false;
  const bridgeSnapshot=run=>({ ...runs.snapshot(run),previousRunId:run.previousRunId ?? null });
  const bridgeModelConfigured=()=>!modelDemo && Boolean(modelClient.key);
  async function bridgeRoute(req,res,url,action,runId,artifactId) {
    const grant=bridgeGrants.authorize(req.headers.authorization,req.headers.origin);
    const owner='extension:'+grant.grantId;
    const answer=(status,body)=>json(res,status,redactBridge(body,secrets));
    const rejectsBody=async()=>{if (Object.keys(await parseBody(req,2_000)).length) throw new AppError('请求不接收其他参数。');};
    if (url.search) throw new AppError('请求不接收查询参数。');
    if (action==='context') {
      await rejectsBody();
      const configured=bridgeModelConfigured();
      const models=configured ? (await modelClient.models()).map(model=>({ id:model.id,label:model.label ?? model.id })) : [];
      bridgeGrants.assertActive(grant);
      return answer(200,{ project:{id:grant.projectId,name:grant.name},models,modelConfigured:configured,
        defaultModel:models.some(model=>model.id===defaultModel)?defaultModel:(models[0]?.id ?? ''),expiresAt:grant.expiresAt,
        testing:grant.access==='testing', automation:grant.automation===true, browserAutomation:grant.browserAutomation===true, fileOperations:grant.fileOperations===true, capabilities:{projectSelection:true,browserAutomation:true,splitAutomation:true} });
    }
    if (action==='disconnect') {
      await rejectsBody();
      bridgeGrants.assertActive(grant);
      bridgeGrants.revoke(grant);
      runs.cancelOwner(owner);
      return answer(200,{ok:true});
    }
    if (action==='list') {
      await rejectsBody();
      bridgeGrants.assertActive(grant);
      return answer(200,{runs:runs.list(owner,bridgeSnapshot)});
    }
    if (action==='runs') {
      const body=await parseBody(req,64_000);
      const prompt=typeof body.prompt==='string'?body.prompt.trim():'';
      if (Object.keys(body).some(key=>!['prompt','model','previousRunId','clientRequestId','projectSelected'].includes(key)) ||
        (Object.hasOwn(body,'projectSelected') && typeof body.projectSelected!=='boolean') ||
        !prompt || prompt.length>16_000 || typeof body.model!=='string' || !body.model || body.model.length>150 ||
        typeof body.clientRequestId!=='string' || !bridgeRequestId.test(body.clientRequestId) ||
        (Object.hasOwn(body,'previousRunId') && (typeof body.previousRunId!=='string' || !bridgeRequestId.test(body.previousRunId)))) {
        throw new AppError('聊天请求须提供消息、模型和唯一请求编号，可附带上一轮。');
      }
      const args={prompt,model:body.model,previousRunId:body.previousRunId,projectId:grant.projectId,...(Object.hasOwn(body,'projectSelected')?{projectSelected:body.projectSelected}:{})};
      const runId=await bridgeGrants.createRun(grant,body.clientRequestId,args,async()=>{
        if (!bridgeModelConfigured()) throw new AppError('请先在 Navi 的连接设置保存模型 API。',409,'MODEL_NOT_CONFIGURED');
        if (editingConnection || preparingTask) throw new AppError('连接设置或浏览器任务正在准备。',409);
        const basePolicy=bridgeGrants.policy(grant);
        const policy=Object.hasOwn(body,'projectSelected') ? {...basePolicy,projectSelected:body.projectSelected,...(!body.projectSelected?{allowedTools:[],testing:false}:{})} : basePolicy;
        const run=await runs.create(args,owner,()=>editingConnection || preparingTask,null,policy);
        return run.id;
      });
      bridgeGrants.assertActive(grant);
      return answer(202,bridgeSnapshot(runs.get(runId,owner)));
    }
    const run=runs.get(runId,owner);
    if (action==='artifact') {
      await rejectsBody();
      bridgeGrants.assertActive(grant);
      const artifact=run.artifacts.get(artifactId);
      if (!artifact) throw new AppError('截图不存在或随运行记录过期。',404,'ARTIFACT_NOT_FOUND');
      return json(res,200,{mime:'image/jpeg',base64:artifact.toString('base64')});
    }
    if (action==='read') {
      await rejectsBody();
      bridgeGrants.assertActive(grant);
      return answer(200,bridgeSnapshot(run));
    }
    if (action==='events/read') {
      const body=await parseBody(req,2_000), after=Object.hasOwn(body,'after') ? body.after : 0;
      if (Object.keys(body).some(key=>key!=='after') || !Number.isSafeInteger(after) || after<0) {
        throw new AppError('事件序号无效。');
      }
      bridgeGrants.assertActive(grant);
      const events=run.events.slice(after,after+30);
      return answer(200,{events,next:events.at(-1)?.seq ?? after,run:bridgeSnapshot(run)});
    }
    if (action==='browser/claim' || action==='browser/result') {
      const body=await parseBody(req,128_000);
      bridgeGrants.assertActive(grant);
      const allowed=action==='browser/claim'?['callId']:['callId','result'];
      if (!grant.browserAutomation || Object.keys(body).some(key=>!allowed.includes(key))) throw new AppError('浏览器操作未授权。',403);
      return answer(200,action==='browser/claim' ? await runs.claimBrowser(run,body.callId) : runs.finishBrowser(run,body.callId,body.result));
    }
    if (action==='decisions') {
      const body=await parseBody(req,2_000);
      if (Object.keys(body).some(key=>!['callId','decision'].includes(key))) throw new AppError('审批决定无效。');
      bridgeGrants.assertActive(grant);
      runs.decision(run,body.callId,body.decision);
      return answer(200,bridgeSnapshot(run));
    }
    if (action==='cancel') {
      await rejectsBody();
      bridgeGrants.assertActive(grant);
      runs.cancel(run);
      return answer(200,bridgeSnapshot(run));
    }
    throw new AppError('未找到接口。',404,'NOT_FOUND');
  }
  const route = async (req, res) => {
    if (req.headers.host !== HOST || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      || ['forwarded','x-forwarded-for','x-forwarded-host','x-real-ip','cf-connecting-ip'].some(h => req.headers[h])) {
      throw new AppError('工作台仅接受本机直接访问。', 403, 'LOOPBACK_ONLY');
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new AppError('无效路径。');
    const url = new URL(req.url, ORIGIN);
    if (url.origin!==ORIGIN) throw new AppError('无效路径。');
    const pathname = url.pathname;
    const method = req.method;
    const extensionAction = pathname.match(/^\/api\/extension\/pair\/(start|status|exchange)$/)?.[1];
    if (extensionAction && ['POST','OPTIONS'].includes(method)) {
      const caller = req.headers.origin;
      if (url.search) throw new AppError('配对请求不接收查询参数。');
      if (extensionCors(req,res,['POST'])) return;
      const body = await parseBody(req,4_096);
      const result = await pairing[extensionAction](body,caller);
      return json(res,extensionAction === 'start' ? 201 : 200,result);
    }
    const matchedRun=pathname.match(bridgeRunPath);
    const matchedArtifact=pathname.match(bridgeArtifactPath);
    const bridgeAction=pathname===bridgeBase+'context/read' ? 'context'
      : pathname===bridgeBase+'disconnect' ? 'disconnect' : pathname===bridgeBase+'runs' ? 'runs'
      : pathname===bridgeBase+'runs/list' ? 'list' : matchedArtifact ? 'artifact' : matchedRun?.[2];
    if (bridgeAction && ['POST','OPTIONS'].includes(method)) {
      // Chrome extension GET requests may omit Origin. Use JSON POST reads so
      // the same required extension-origin and bearer checks apply to all calls.
      if (extensionCors(req,res,['POST'],true)) return;
      try { return await bridgeRoute(req,res,url,bridgeAction,matchedRun?.[1] ?? matchedArtifact?.[1],matchedArtifact?.[2]); }
      catch (error) {
        if (error instanceof AppError) throw new AppError(redactBridge(error.message,secrets),error.status,redactBridge(error.code,secrets));
        throw new AppError('Navi Link 聊天请求失败，请稍后重试。',502,'EXTENSION_BRIDGE_ERROR');
      }
    }
    if (req.headers.origin && req.headers.origin !== ORIGIN || ![undefined, 'none', 'same-origin'].includes(req.headers['sec-fetch-site'])) {
      throw new AppError('拒绝跨站请求。', 403, 'ORIGIN_DENIED');
    }
    if (method === 'GET' && Object.hasOwn(files, pathname)) {
      const [file, type] = files[pathname];
      const buffer = await readFile(path.join(ROOT, 'public', file));
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      res.end(buffer);
      return;
    }
    if (!pathname.startsWith('/api/')) throw new AppError('未找到页面。', 404, 'NOT_FOUND');
    if (method === 'GET' && pathname === '/api/instance') {
      const nonce = url.searchParams.get('nonce');
      if (!operatorMarker.test(nonce ?? '')) throw new AppError('实例验证参数无效。');
      let key;
      try { key=(await readFile(instanceFile,'utf8')).trim(); } catch {}
      if (!operatorMarker.test(key ?? '')) throw new AppError('实例未初始化。',404,'INSTANCE_UNAVAILABLE');
      return json(res,200,{product:'qizhou-workbench',signature:createHmac('sha256',key).update(nonce).digest('hex')});
    }
    if (method === 'POST' && pathname === '/api/operator/ticket') {
      if (req.headers.origin !== ORIGIN || req.headers['x-workbench-client'] !== 'operator-ui') {
        throw new AppError('请从Navi页面打开。',403,'ORIGIN_DENIED');
      }
      const rejected=()=>new AppError('打开链接已失效，请重新双击Navi。',401,'TICKET_INVALID');
      const {ticket}=await parseBody(req,2_000);
      if (typeof ticket!=='string'||!operatorMarker.test(ticket)||consumingTicket) throw rejected();
      consumingTicket=true;
      try {
        let record;
        try { record=JSON.parse(await readFile(ticketFile,'utf8')); } catch { throw rejected(); }
        if (!/^[0-9a-f]{64}$/.test(record?.hash ?? '') || !Number.isSafeInteger(record.expiresAt)
          || record.expiresAt<=Date.now() || record.expiresAt>Date.now()+65_000
          || !timingSafeEqual(digest(ticket),Buffer.from(record.hash,'hex'))) throw rejected();
        // This is serialized per operator instance; the private file is removed
        // before we issue a session, so concurrent requests cannot reuse it.
        try { await unlink(ticketFile); } catch { throw rejected(); }
        return openSession(res);
      } finally { consumingTicket=false; }
    }
    if (method === 'POST' && pathname === '/api/operator/login') {
      if (req.headers.origin !== ORIGIN || req.headers['x-workbench-client'] !== 'operator-ui') {
        throw new AppError('请在工作台页面内登录。', 403, 'ORIGIN_DENIED');
      }
      failures = failures.filter(time => time > Date.now() - 60_000);
      if (failures.length >= 8) throw new AppError('尝试次数过多，请稍后再试。', 429);
      const body = await parseBody(req, 4_000);
      if (!config.operatorToken || typeof body.token !== 'string' || !timingSafeEqual(digest(body.token.trim()), digest(config.operatorToken))) {
        failures.push(Date.now());
        throw new AppError('操作员密钥不正确。', 401, 'LOGIN_FAILED');
      }
      failures.length = 0;
      return openSession(res);
    }
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)nexus_operator=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    const session = sessions.get(cookie);
    if (!session || session.expiresAt <= Date.now()) throw new AppError('请登录工作台。', 401, 'OPERATOR_REQUIRED');
    if (method !== 'GET' && (req.headers.origin !== ORIGIN || req.headers['x-csrf-token'] !== session.csrf)) {
      throw new AppError('请求未通过工作台同源校验。', 403, 'CSRF_DENIED');
    }
    if (method === 'GET' && pathname === '/api/operator/session') return json(res, 200, { csrf: session.csrf });
    if (method === 'GET' && pathname === '/api/deployments') {
      const { enabled, revision, config, jobs } = await deployments.read();
      return json(res, 200, { enabled, revision, configured: Boolean(config), hasPanel: Boolean(config?.panelUrl),
        jobs: jobs.map(({ id, action, revision, status, stage, startedAt, message, containers }) => ({
          id, action, revision, status, stage, startedAt, message,
          containers: containers.map(({ service, image, state, health }) => ({ service, image, state, health }))
        })) });
    }
    if (method === 'GET' && pathname === '/api/deployments/panel') {
      const { config } = await deployments.read();
      if (!config?.panelUrl) throw new AppError('未配置管理面板。', 404);
      res.writeHead(302, { Location: new URL(config.panelUrl).href, 'Referrer-Policy': 'no-referrer' });
      res.end();
      return;
    }
    if (method === 'POST' && pathname === '/api/deployments/jobs') {
      const { id, status } = await deployments.start(await parseBody(req, 2_048));
      return json(res, 202, { id, status });
    }
    if (method === 'POST' && pathname === '/api/operator/logout') {
      sessions.delete(cookie);
      res.setHeader('Set-Cookie', 'nexus_operator=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    const pairRequest = pathname.match(/^\/api\/extension\/pair\/([A-Za-z0-9_-]{43})(?:\/(approve|deny))?$/);
    if (pairRequest) {
      const [,id,operation] = pairRequest;
      if (method === 'GET' && !operation) return json(res,200,pairing.inspect(id));
      if (method === 'POST' && operation) {
        const body = await parseBody(req,4_096);
        return json(res,200,operation === 'approve'
          ? await pairing.approve(id,body,()=>sessions.get(cookie) === session && session.expiresAt > Date.now())
          : pairing.deny(id,body));
      }
    }
    if (method === 'GET' && pathname === '/api/status') {
      const check = async fn => {
        try { return { ok: true, ...(await fn()) }; }
        catch (e) { return { ok: false, message: clean(e?.message) || '连接失败' }; }
      };
      const [gateway, n, runner, model] = await Promise.all([
        health(new URL('/readyz', activeCprUrl)),
        check(async () => ({ tools: (await nexus.listTools(AbortSignal.timeout(5_000))).size })),
        check(async () => ({ runners: (await nexus.runners(AbortSignal.timeout(5_000))).length })),
        check(async () => ({ models: (await modelClient.models(AbortSignal.timeout(5_000))).length }))
      ]);
      return json(res, 200, {
        mode, demoExample:config.desktopExample && modelDemo ? desktopExamplePrompt : null, defaultModel, sandboxPath: config.sandboxPath, browserLabPath: config.browserLabPath, urls: { cpr: activeCprUrl, nexus: config.nexusUrl },
        cpr: { ok: gateway, configured: Boolean(modelClient.key) }, nexus: { ...n, simulated: demo },
        runner: { ...runner, ok: runner.ok && runner.runners > 0, simulated: demo },
        model: { ...model, ok: model.ok && model.models > 0, simulated: modelDemo }
      });
    }
    if (method === 'GET' && pathname === '/api/settings/connection') {
      return json(res,200,{baseUrl:activeCprUrl,keyConfigured:Boolean(modelClient.key),defaultModel,mode});
    }
    if (method === 'POST' && pathname === '/api/settings/connection/test') {
      const body = await parseBody(req,8_000);
      const target = Object.hasOwn(body,'baseUrl') ? cprBaseUrl(body.baseUrl) : activeCprUrl;
      const incoming = typeof body.clientKey === 'string' ? body.clientKey.trim() : '';
      const supplied = incoming || (target === activeCprUrl ? modelClient.key : '');
      if (typeof supplied !== 'string' || !/^[\x21-\x7e]{8,2048}$/.test(supplied)) throw new AppError('请输入 CPR Client Key。');
      const client = new Cpr({url:target,key:supplied});
      try { return json(res,200,{models:await client.models(),baseUrl:target}); }
      catch(error) { throw new AppError(cleanMessage(error?.message,[supplied]) || '连接失败。',error.status || 502,error.code); }
    }
    if (method === 'GET' && pathname === '/api/models') return json(res, 200, { models: await modelClient.models(), defaultModel });
    if (method === 'POST' && pathname === '/api/settings/model') {
      const body = await parseBody(req);
      if (Object.hasOwn(body, 'clientKey') || Object.hasOwn(body, 'baseUrl')) {
        if (demo) throw new AppError('完整模拟模式未连接本机 Nexus。请先启动真实工具链。', 409);
        if (editingConnection || runs.hasActive()) throw new AppError('请先结束当前运行或连接检测。', 409);
        const target = Object.hasOwn(body,'baseUrl') ? cprBaseUrl(body.baseUrl) : activeCprUrl;
        const incoming = typeof body.clientKey === 'string' ? body.clientKey.trim() : '';
        if (!incoming && target !== activeCprUrl) throw new AppError('更换 Base URL 时请重新输入此网关的 Client Key。');
        const supplied = incoming || modelClient.key;
        if (typeof supplied !== 'string' || !/^[\x21-\x7e]{8,2048}$/.test(supplied)) {
          throw new AppError('请输入有效的 CPR Client Key。');
        }
        editingConnection = true;
        try {
          const pending = new Cpr({url:target,key:supplied});
          const available = await pending.models();
          const selected = body.defaultModel || (available.some(value=>value.id===defaultModel) ? defaultModel : available[0]?.id);
          if (!selected || !available.some(value=>value.id===selected)) throw new AppError('检测成功，但没有确认可用的模型。请先在 CPR 配好上游账号，再测试并选择模型。');
          if (!opts.noPersist) await privateWrite(path.join(RUNTIME,'private','cpr-settings.json'),
            JSON.stringify({baseUrl:target,clientKey:supplied,defaultModel:selected})+'\n');
          if (!secrets.includes(supplied)) secrets.push(supplied);
          modelClient = pending;
          runs.modelClient = pending;
          activeCprUrl = target;
          modelDemo = false;
          mode = 'local';
          defaultModel = selected;
          return json(res, 200, { configured: true, baseUrl:target, defaultModel, modelCount: available.length });
        } catch(error) {
          throw new AppError(cleanMessage(error?.message,[supplied]) || '连接失败。',error.status || 502,error.code);
        } finally { editingConnection = false; }
      }
      if (editingConnection || runs.hasActive()) throw new AppError('请先结束当前运行或连接检测。',409);
      editingConnection = true;
      try {
        const selected = body.defaultModel;
        if (!(await modelClient.models()).some(m=>m.id===selected)) throw new AppError('请选择连接中可用的模型。');
        if (!opts.noPersist) {
          if (mode === 'local' && modelClient.key) await privateWrite(path.join(RUNTIME,'private','cpr-settings.json'),
            JSON.stringify({baseUrl:activeCprUrl,clientKey:modelClient.key,defaultModel:selected})+'\n');
          else await privateWrite(path.join(RUNTIME,'model.'+mode+'.txt'),selected+'\n');
        }
        defaultModel = selected;
        return json(res,200,{defaultModel});
      } finally { editingConnection = false; }
    }
    if (method === 'GET' && pathname === '/api/projects') return json(res, 200, { projects: await nexus.projects() });
    if (method === 'POST' && pathname === '/api/projects') {
      const body = await parseBody(req);
      if (!safeProjectPath(body.path) || typeof body.name !== 'string' || body.name.trim().length > 100) {
        throw new AppError('请输入完整项目目录路径，不能直接授权磁盘根目录。');
      }
      let verifiedPath = body.path.trim();
      if (!demo) {
        try { verifiedPath = await realpath(verifiedPath); if (!(await stat(verifiedPath)).isDirectory()) throw new Error(); }
        catch { throw new AppError('此路径不是可访问的本机文件夹。'); }
        const runtimePath=await realpath(RUNTIME).catch(error=>{if (error.code!=='ENOENT') throw error; return RUNTIME;});
        const critical=(await Promise.all(['private','nexus','upstream','cpr'].map(async name=>{
          const directory=path.join(runtimePath,name);
          const resolved=await realpath(directory).catch(error=>{if (error.code!=='ENOENT') throw error; return directory;});
          return [directory,resolved];
        }))).flat();
        const overlaps = (p, q) => p === q || p.startsWith(q + path.sep) || q.startsWith(p + path.sep);
        if (critical.some(p => overlaps(verifiedPath,p))) throw new AppError('不能授权包含工作台内部数据的目录。');
      }
      const registered = await nexus.manage(projectBase + '/authorize', {
        method: 'POST', body: { path: verifiedPath, name: body.name.trim() || undefined, accessMode: 'read-only' }
      });
      const project = (await nexus.projects()).find(p => p.id === registered.id);
      if (!project) throw new AppError('注册请求已返回，暂未读回项目，请刷新。', 409);
      return json(res, 201, { project: projectView(project) });
    }
    let match = pathname.match(/^\/api\/projects\/([^/]+)\/permissions$/);
    if (method === 'PATCH' && match) {
      return json(res, 200, { project: await projectsWithPermission(nexus, projectBase, routeId(match[1]), await parseBody(req)) });
    }
    match = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (method === 'GET' && match) {
      const projectId = routeId(match[1]);
      if (!(await nexus.projects()).some(p => p.id === projectId && p.enabled)) throw new AppError('项目不存在或未启用。', 404);
      const result = await nexus.call('localbridge_session_list', { projectId, ...cursorQuery(url.searchParams) });
      const data = textOutput(result);
      if (result.isError || !Array.isArray(data?.sessions)) throw new AppError('Nexus 无法返回项目会话。', 502);
      return json(res, 200, data);
    }
    match = pathname.match(/^\/api\/nexus\/sessions\/([^/]+)\/events$/);
    if (method === 'GET' && match) {
      const sessionId = routeId(match[1]);
      const projectId = routeId(url.searchParams.get('projectId') || '');
      if (!(await nexus.projects()).some(p => p.id === projectId && p.enabled)) throw new AppError('项目不存在或未启用。', 404);
      if (!demo) {
        const context = await nexus.call('localbridge_session_status', { sessionId, projectId });
        if (context.isError || textOutput(context)?.projectId !== projectId) throw new AppError('没有找到该项目下的会话。', 404);
      }
      const result = await nexus.call('localbridge_session_events', { sessionId, ...cursorQuery(url.searchParams) });
      const data = textOutput(result);
      if (result.isError || !Array.isArray(data?.events)) throw new AppError('Nexus 无法返回该会话的事件。', 502);
      return json(res, 200, data);
    }
    match = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
    if (method === 'GET' && match) {
      const artifact = runs.get(routeId(match[1]), 'operator').artifacts.get(routeId(match[2]));
      if (!artifact) throw new AppError('截图不存在或随运行记录过期。', 404);
      res.writeHead(200, {'Content-Type':'image/jpeg','Content-Length':artifact.length});
      res.end(artifact);
      return;
    }
    if (method==='GET'&&pathname==='/api/web-tasks/status') return json(res,200,await browserPrep.status());
    if (method==='POST'&&pathname==='/api/web-tasks/prepare') {
      await parseBody(req,2000);
      if (runs.hasActive()||preparingTask) throw new AppError('请先结束当前运行。',409);
      browserPrep.begin();
      return json(res,202,await browserPrep.status());
    }
    if (method==='POST'&&pathname==='/api/web-tasks') {
      const data=await parseBody(req);
      const url=targetUrl(data.url);
      if (typeof data.prompt!=='string'||!data.prompt.trim()||data.prompt.length>8_000||typeof data.model!=='string') {
        throw new AppError('请填写用例描述并选择模型。');
      }
      if (modelDemo&&url) throw new AppError('验证任意网址需要先配置真实模型。也可以清空网址试用自带表单。',409);
      if (config.desktopExample && modelDemo && data.prompt!==desktopExamplePrompt) {
        throw new AppError('尚未配置 API，当前只可运行预设的内置表单示例。',409);
      }
      if (editingConnection||preparingTask||runs.hasActive()) throw new AppError('请先结束当前运行或连接设置。',409);
      const browserStatus=await browserPrep.status();
      if (!browserStatus.ready||browserStatus.state==='preparing') throw new AppError('请先准备浏览器环境。',409);
      preparingTask=true;
      try {
        const project=await ensureBrowserProject(nexus,config.browserLabPath,
          (id,changes)=>projectsWithPermission(nexus,projectBase,routeId(id),changes));
        const run=await runs.create({projectId:project.id,prompt:data.prompt,model:data.model,
            approvalMode:'writes',maxRounds:data.maxRounds??12},'operator',()=>editingConnection,{url,inspect:!modelDemo});
        return json(res,202,runs.snapshot(run));
      } finally { preparingTask=false; }
    }
    if (method === 'GET' && pathname === '/api/runs') return json(res, 200, { runs: runs.list('operator') });
    if (method === 'POST' && pathname === '/api/runs') {
      if (config.desktopExample && modelDemo) throw new AppError('尚未配置 API。可体验内置网页示例；项目任务需先在连接设置保存 URL 和 Key。',409);
      if (editingConnection || preparingTask) throw new AppError('连接设置或浏览器任务正在准备。',409);
      const run = await runs.create(await parseBody(req), 'operator', () => editingConnection);
      return json(res, 202, runs.snapshot(run));
    }
    match = pathname.match(/^\/api\/runs\/([^/]+)(?:\/(events|decisions|cancel))?$/);
    if (match) {
      const run = runs.get(routeId(match[1]), 'operator');
      if (method === 'GET' && !match[2]) return json(res, 200, runs.snapshot(run));
      if (method === 'GET' && match[2] === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isInteger(after) || after < 0) throw new AppError('事件序号无效。');
        const events = run.events.slice(after, after + 30);
        return json(res, 200, { events, next: events.at(-1)?.seq ?? after, run: runs.snapshot(run) });
      }
      if (method === 'POST' && match[2] === 'cancel') {
        runs.cancel(run); return json(res, 200, runs.snapshot(run));
      }
      if (method === 'POST' && match[2] === 'decisions') {
        const { callId, decision } = await parseBody(req);
        runs.decision(run, callId, decision); return json(res, 200, runs.snapshot(run));
      }
    }
    if (method === 'GET' && pathname === '/api/nexus/approvals') {
      return json(res, 200, { approvals: await nexus.approvals() });
    }
    match = pathname.match(/^\/api\/nexus\/approvals\/([^/]+)\/resolve$/);
    if (method === 'POST' && match) {
      const id = routeId(match[1]);
      const body = await parseBody(req);
      if (!['approve', 'deny'].includes(body.action)) throw new AppError('无效的审批动作。');
      const pending = (await nexus.approvals()).find(a => a.id === id && a.status === 'pending');
      if (!pending) throw new AppError('该 Nexus 审批已处理或失效。', 409);
      const value = await nexus.resolveApproval(id, body.action, pending.runnerId);
      return json(res, 200, { approval: value });
    }
    if (method === 'POST' && pathname === '/api/extension-token') {
      const body = await parseBody(req);
      if (demo || !['read', 'read-write', 'read-write-execute'].includes(body.access)) {
        throw new AppError(demo ? '完整模拟模式不能签发真实扩展令牌。' : '令牌权限无效。', 409);
      }
      const scopes = ['read', ...(body.access !== 'read' ? ['write'] : []), ...(body.access === 'read-write-execute' ? ['execute'] : [])];
      const result = await nexus.manage('/api/tokens', {
        method: 'POST', body: {
          name: 'Workbench browser extension', type: 'mcp', scopes,
          expiresAt: Date.now() + 7 * 24 * 3600_000
        }
      });
      if (!/^lb_/.test(result?.token)) throw new AppError('未收到有效 MCP 令牌。', 502);
      return json(res, 201, { token: result.token, tokenId: result.id, scopes, endpoint: config.nexusUrl, expiresAt: result.expiresAt });
    }
    throw new AppError('未找到接口。', 404, 'NOT_FOUND');
  };
  const server = createServer({ requestTimeout: 20_000, headersTimeout: 8_000, maxHeaderSize: 16_384 }, (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    };
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    route(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof AppError && error.status >= 400 && error.status <= 599 ? error.status : 502;
      json(res, status, { error: { code: cleanCode(error?.code, secrets, 'WORKBENCH_ERROR'),
        message: clean(error?.message) || '工作台请求失败。' } });
    });
  });
  server.stopBrowserPreparation = () => browserPrep.stop();
  server.once('close', server.stopBrowserPreparation);
  server.once('close', () => deployments.stop());
  return server;
}

export async function startWorkbench(config) {
  const srv = createWorkbench(config);
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: PORT, exclusive: true }, resolve);
  });
  console.log('Navi: ' + ORIGIN + ' · ' + config.mode);
  return srv;
}
