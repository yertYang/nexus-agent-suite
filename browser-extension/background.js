// SPDX-License-Identifier: GPL-3.0-only
import "./core/protocol.js";
import { DirectChat } from "./core/direct-chat.js";
import { DirectApi, modelBaseUrl, cleanDirect } from "./core/direct-api.js";
import { executeBrowser } from "./core/browser.js";
import { McpClient } from "./core/mcp.js";
import { BridgeError, bridgeGrant, bridgeRequest, redactBridge } from "./core/bridge.js";
import { READ_TOOLS, approvalUrl, approvedNotification, exchangePair, newVerifier,
  projectId as validProjectId, startPair, statusPair } from "./core/pair.js";

const P = globalThis.NexusProtocol;
const DIRECT = "navi.private.direct.config";
const MODE = "navi.private.chat.mode";
let directConfig=null, chatMode=null, directChat;
const CONFIG = "nexus.private.config";
const SESSIONS = "nexus.private.sessions";
const PAIR = "nexus.private.pair";
const PENDING_TTL = 5 * 60_000;
const SESSION_TTL = 45 * 60_000;
const panelUrl = chrome.runtime.getURL("panel.html");
const extensionOrigin = panelUrl.slice(0, -"/panel.html".length);
// Set on every worker start, including unpacked reloads and extension upgrades.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
const running = new Map();
let cached = null;
let queue = Promise.resolve();
let pairQueue = Promise.resolve();

const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  directConfig=(await chrome.storage.local.get(DIRECT))[DIRECT] ?? null;
  chatMode=(await chrome.storage.local.get(MODE))[MODE] ?? null;
  const sessions = await load();
  let changed = false;
  for (const session of sessions) {
    if (session.entry?.status === "running") {
      session.entry.status = "interrupted";
      session.entry.text = "浏览器中断了等待；工具可能已被 Nexus 接收。请核实执行状态。";
      session.pause = true;
      changed = true;
    }
  }
  if (changed) await save(sessions);
})();

function serial(task) {
  const work = queue.then(() => ready).then(task);
  queue = work.catch(() => {});
  return work;
}
async function load() {
  return (await chrome.storage.session.get(SESSIONS))[SESSIONS] ?? [];
}
async function save(sessions) {
  await chrome.storage.session.set({ [SESSIONS]: sessions });
}
async function settings() {
  return (await chrome.storage.local.get(CONFIG))[CONFIG] ?? {
    token: null, projectId: "", selected: [], revision: "initial",
  };
}
function usable(config) {
  return P.validToken(config.token) && (!config.paired || config.tokenExpiresAt > Date.now());
}
function currentMode(config) { return chatMode || (directConfig?.key ? "direct" : bridgeGrant(config.bridge) ? "navi" : "direct"); }
function engine() { return directChat ??= new DirectChat({api:chrome,config:async()=>directConfig}); }
function directView(config) { return {mode:currentMode(config),configured:Boolean(directConfig?.key),baseUrl:directConfig?.baseUrl ?? "",defaultModel:directConfig?.defaultModel ?? "",models:directConfig?.models ?? []}; }
function exposeSettings(config) {
  const endpointReady = usable(config);
  const catalogue = cached?.revision === config.revision && endpointReady ?
    cached.tools.filter((tool) => !config.paired || READ_TOOLS.includes(tool.name)) : [];
  return { configured: endpointReady, projectId: config.projectId, projectName: config.projectName ?? "",
    chatConnected: currentMode(config)==="direct" || Boolean(bridgeGrant(config.bridge)),
    chatMode:currentMode(config),connectionId:currentMode(config)==="direct" ? (directConfig?.revision || "direct-unconfigured") : config.bridge?.grantId ?? "navi-unconnected",
    direct:directView(config),
    paired: config.paired === true, expired: config.paired === true && !endpointReady,
    selectionPending: config.autoSelect === true, tokenExpiresAt: config.tokenExpiresAt ?? null,
    selected: config.selected, catalogue,
    version: cached?.revision === config.revision && endpointReady ? cached.version : null };
}
async function pairRecord() {
  return (await chrome.storage.session.get(PAIR))[PAIR];
}
function isPending(record, config) {
  return record?.revision === config.revision && record.expiresAt > Date.now();
}
async function pairingView(state) {
  const config = await settings();
  const record = await pairRecord();
  return { ...exposeSettings(config), pairState: state ??
    (isPending(record, config) ? "pending" : record?.revision === config.revision ? "expired" : "idle") };
}
function pairingOperation(task) {
  const result = pairQueue.then(task);
  pairQueue = result.catch(() => {});
  return result;
}

function allowedArguments(config, args) {
  if (args.projectId !== config.projectId) return false;
  if (!config.paired) return true;
  function matches(value) {
    if (!value || typeof value !== "object") return true;
    return Object.entries(value).every(([key, nested]) =>
      (key === "projectId" || key === "project_id") ? nested === config.projectId : matches(nested));
  }
  return matches(args);
}
async function tabRoute(tabId) {
  try { return P.siteUrl((await chrome.tabs.get(tabId)).url); }
  catch { return null; }
}
function badge(tabId, text) {
  void chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}
function fail(message) { throw new Error(message); }

function source(sender, type) {
  if (sender.id !== chrome.runtime.id) fail("消息来源不受信任。");
  if (type === "popup") {
    if (sender.url !== panelUrl || sender.origin !== extensionOrigin ||
      (sender.frameId !== undefined && sender.frameId !== 0) ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active")) {
      fail("只能在扩展侧栏中确认或修改配置。");
    }
    return;
  }
  const route = P.siteUrl(sender.url);
  if (!route || sender.origin !== new URL(route).origin ||
    sender.frameId !== 0 || !sender.documentId || !Number.isInteger(sender.tab?.id) ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active")) {
    fail("消息必须来自受支持网页的活动顶层文档。");
  }
  return { tabId: sender.tab.id, documentId: sender.documentId, route };
}
function samePage(session, page) {
  return session && session.route === page.route && session.documentId === page.documentId;
}
function findSession(sessions, tabId) {
  return sessions.find((item) => item.tabId === tabId);
}
function expire(session) {
  if (!session || session.entry?.status !== "pending" || session.entry.expires > Date.now()) return false;
  session.entry.status = "expired";
  session.entry.text = "待确认请求已过期。";
  badge(session.tabId, "");
  return true;
}
function pageState(session, forPopup = false) {
  if (!session) return { armed: false, rounds: 0, max: P.MAX_ROUNDS };
  const { entry } = session;
  return {
    armed: !session.pause && session.expires > Date.now(),
    rounds: session.rounds, max: P.MAX_ROUNDS, notice: session.notice,
    entry: entry && {
      id: entry.id, key: entry.key, status: entry.status,
      tool: entry.call.tool, modelId: entry.call.id,
      approval: entry.approval, consumed: entry.consumed ?? false, retryUsed: entry.retryUsed ?? false,
      ...(forPopup ? { arguments: entry.call.arguments, text: entry.text, created: entry.created } : {}),
    },
  };
}
function entryMatches(session, entry, message) {
  return session && entry && message.pendingId === entry.id;
}

async function clientFor(config, signal, fresh = false) {
  if (!usable(config)) fail(config.paired ? "Navi 配对已过期，请重新连接。" : "请先连接 Navi，或在高级设置中手动配置。");
  if (!fresh && cached?.revision === config.revision) return cached;
  const client = new McpClient(config.token);
  const tools = await client.listTools(signal);
  const record = { client, revision: config.revision, tools, version: client.version };
  if ((await settings()).revision !== config.revision) fail("配置已变化，请重试。");
  cached = record;
  return record;
}

function removeSession(sessions, tabId) {
  const index = sessions.findIndex((item) => item.tabId === tabId);
  if (index !== -1) sessions.splice(index, 1);
  const active = running.get(tabId);
  active?.controller.abort();
  badge(tabId, "");
}
async function currentSession(page, lease, requireActive = false) {
  const sessions = await load();
  const session = findSession(sessions, page.tabId);
  if (!samePage(session, page) || lease !== session.lease) {
    fail("此页面的监听已停止，请重新启用。");
  }
  if (requireActive && (session.pause || session.expires <= Date.now())) {
    fail("监听已暂停或过期，请重新启用。");
  }
  if (expire(session)) await save(sessions);
  return { sessions, session };
}

async function handlePage(message, page) {
  if (message.route !== page.route || await tabRoute(page.tabId) !== page.route) {
    fail("检测到页面跳转，请在当前对话重新启用。");
  }

  switch (message.type) {
    case "page.arm":
      return serial(async () => {
        const config = await settings();
        if (!usable(config) || !config.projectId || !config.selected.length) fail("请在扩展侧栏连接 Navi，或在高级设置配置可用工具。");
        const sessions = (await load()).filter((item) => item.expires > Date.now());
        if (running.has(page.tabId)) fail("正在等待 Nexus，请先停止当前调用。");
        removeSession(sessions, page.tabId);
        if (sessions.length >= 30) fail("正在监听的对话过多，请先关闭一个页面的监听。");
        const lease = crypto.randomUUID();
        sessions.push({ ...page, lease, expires: Date.now() + SESSION_TTL, revision: config.revision,
          rounds: 0, failures: 0, seen: [], repeated: 0, pause: false });
        await save(sessions);
        return { lease, ...pageState(sessions.at(-1)) };
      });

    case "page.stop":
      return serial(async () => {
        const { sessions, session } = await currentSession(page, message.lease);
        if (session.entry?.status === "running") running.get(page.tabId)?.controller.abort();
        removeSession(sessions, page.tabId);
        await save(sessions);
        return pageState(null);
      });

    case "page.advance":
      return serial(async () => {
        const { sessions, session } = await currentSession(page, message.lease);
        if (session.entry?.status === "running") {
          const active = running.get(page.tabId);
          active?.controller.abort();
          if (active?.sent) {
            session.pause = true;
            session.notice = "新消息已发送，上一工具结果未确认。工具可能已在 Nexus 执行，请核对后再启用监听。";
          }
        }
        if (session.entry) delete session.entry;
        badge(page.tabId, "");
        await save(sessions);
        return pageState(session);
      });

    case "page.stage":
      return serial(async () => {
        const { sessions, session } = await currentSession(page, message.lease, true);
        const config = await settings();
        if (config.revision !== session.revision) fail("配置已变化，请重新启用。");
        if (session.entry) fail("此轮已有请求，请先处理。");
        if (typeof message.key !== "string" || !/^[0-9a-f]{64}$/.test(message.key)) fail("工具提议缺少有效消息标识。");
        const call = P.parseCall(message.source);
        if (!usable(config)) fail("Navi 配对已过期，请重新连接。");
        if (!config.selected.includes(call.tool) || (config.paired && !READ_TOOLS.includes(call.tool))) fail("请求的工具未在扩展侧栏启用。");
        if (!allowedArguments(config, call.arguments)) fail("工具请求的项目与扩展中配置的项目不一致。");
        const signature = await P.hash(P.canonical([call.tool, call.arguments]));
        if (session.seen.includes(message.key)) fail("此会话已经处理过相同调用。");
        if (session.seen.length >= 48) fail("本次监听中的提议过多，请重新启用。");
        if (session.rounds >= P.MAX_ROUNDS) fail("本次监听已达到调用轮次上限。");
        const now = Date.now();
        session.seen.push(message.key);
        session.entry = {
          id: crypto.randomUUID(), key: message.key, signature, call,
          status: "pending", created: now, expires: now + PENDING_TTL,
        };
        await save(sessions);
        badge(page.tabId, "1");
        return pageState(session);
      });

    case "page.state":
      return serial(async () => {
        const { session } = await currentSession(page, message.lease);
        return pageState(session);
      });

    case "page.result":
      return serial(async () => {
        const { session } = await currentSession(page, message.lease);
        const entry = session.entry;
        if (!entryMatches(session, entry, message) ||
          !["success", "error"].includes(entry.status) || entry.consumed) fail("此页面没有可插入的结果。");
        return {
          text: "【Nexus 工具结果】\n工具：" + entry.call.tool +
            "\n状态：" + (entry.status === "success" ? "成功" : "失败") + "\n" + entry.text,
        };
      });

    case "page.consumed":
      return serial(async () => {
        const { sessions, session } = await currentSession(page, message.lease);
        if (entryMatches(session, session.entry, message)) {
          session.entry.consumed = true;
          delete session.entry.text;
          await save(sessions);
        }
        return pageState(session);
      });

    case "page.open-panel":
      await serial(async () => { await currentSession(page, message.lease); });
      // The toolbar is the fallback if the browser drops the forwarded user gesture.
      try { await chrome.sidePanel.open({ tabId: page.tabId }); } catch {}
      return {};
    default: fail("未知的网页操作。");
  }
}

async function execute(message) {
  const retry = message.type === "popup.retry";
  const job = await serial(async () => {
    const sessions = await load();
    const session = findSession(sessions, message.tabId);
    const entry = session?.entry;
    if (!entryMatches(session, entry, message) || session.pause ||
      (retry ? entry.status !== "approval" || !entry.approval?.id || entry.retryUsed :
        entry.status !== "pending" || entry.expires <= Date.now()) ||
      session.expires <= Date.now() || session.rounds >= P.MAX_ROUNDS ||
      running.has(message.tabId)) fail("工具请求已变化、过期或处理，请返回当前对话。");
    const config = await settings();
    if (!usable(config) || config.revision !== session.revision || !config.selected.includes(entry.call.tool) ||
      (config.paired && !READ_TOOLS.includes(entry.call.tool)) || !allowedArguments(config, entry.call.arguments)) fail("项目或启用工具已变化，请重新提议。");
    if (await tabRoute(session.tabId) !== session.route) fail("网页已经跳转，工具未执行。");
    const verification = await chrome.tabs.sendMessage(session.tabId, {
      type: "worker.verify", route: session.route, lease: session.lease, key: entry.key,
    }, { documentId: session.documentId }).catch(() => null);
    if (verification?.valid !== true || await tabRoute(session.tabId) !== session.route) {
      fail("网页回复已变化或已跳转，工具未执行。");
    }
    const controller = new AbortController();
    const job = { controller, config, entry, session, sent: false };
    running.set(session.tabId, job);
    entry.status = "running";
    if (!retry) session.rounds++;
    try { await save(sessions); } catch (error) { running.delete(session.tabId); throw error; }
    badge(session.tabId, "…");
    return job;
  });

  const { config, entry, session, controller } = job;
  let result;
  try {
    const { client, tools } = await clientFor(config, controller.signal);
    if (!tools.some((tool) => tool.name === entry.call.tool)) fail("Nexus 已不再提供此工具，请刷新工具列表。");
    if (await tabRoute(session.tabId) !== session.route) controller.abort();
    const approval = entry.approval;
    let args = entry.call.arguments;
    if (retry) {
      try {
        const status = await client.approvalStatus(approval.id, controller.signal);
        if (status !== "approved") {
          const states = { pending: "Nexus 审批仍待处理。", denied: "Nexus 审批已拒绝。",
            expired: "Nexus 审批已过期。", consumed: "此审批已被使用。" };
          result = { status: "approval", approval, text: states[status] ?? "Nexus 审批未通过。",
            retryUsed: ["denied", "expired", "consumed"].includes(status) };
        } else {
          await serial(async () => {
            const sessions = await load();
            const current = findSession(sessions, session.tabId);
            if (controller.signal.aborted || !entryMatches(current, current?.entry, { pendingId: entry.id }) ||
              await tabRoute(session.tabId) !== session.route) fail("页面或调用已变化。");
            const verification = await chrome.tabs.sendMessage(session.tabId, {
              type: "worker.verify", route: session.route, lease: session.lease, key: entry.key,
            }, { documentId: session.documentId }).catch(() => null);
            if (verification?.valid !== true || await tabRoute(session.tabId) !== session.route) {
              fail("网页回复已变化或已跳转，工具未执行。");
            }
            current.rounds++;
            current.entry.retryUsed = true;
            await save(sessions);
          });
          args = { ...args, approvalId: approval.id };
        }
      } catch (error) {
        result = { status: "approval", approval, text: P.redact(String(error.message)).slice(0, 500) };
      }
    }
    if (!result) {
      const mcpResult = await client.call(entry.call.tool, args, {
        signal: controller.signal, key: "browser-" + entry.id + (retry ? "-approved" : ""),
        onDispatch: () => { job.sent = true; },
      });
      if (!P.object(mcpResult) || (!Array.isArray(mcpResult.content) && !P.object(mcpResult.structuredContent))) {
        fail("Nexus 响应缺少有效工具结果。");
      }
      result = P.publicResult(mcpResult);
    }
  } catch (error) {
    if (error?.status === 404 && cached?.revision === config.revision) cached = null;
    const approval = P.approvalFrom(error?.data);
    const text = P.redact(String(error.message || "工具请求失败。")).slice(0, 500);
    result = approval ? { status: "approval", approval } : job.sent && error?.definite !== true
      ? { status: "interrupted", text: text + " 工具可能已执行。监听已暂停，请在 Nexus 核实实际状态。" }
      : { status: "error", text };
  }
  if (controller.signal.aborted) result = {
    status: "cancelled",
    text: job.sent ? "已停止等待。Nexus 可能已收到并执行请求，请核对实际状态。" : "已取消，工具请求未发送。",
  };
  return serial(async () => {
    if (running.get(session.tabId) === job) running.delete(session.tabId);
    const sessions = await load();
    const latest = findSession(sessions, session.tabId);
    if (!entryMatches(latest, latest?.entry, { pendingId: entry.id })) return pageState(latest, true);
    delete latest.entry.text;
    delete latest.entry.approval;
    Object.assign(latest.entry, result);
    latest.failures = result.status === "error" ? latest.failures + 1 : 0;
    if (["success", "error"].includes(result.status)) {
      const resultFingerprint = await P.hash(P.canonical([entry.signature, result.status, result.text]));
      latest.repeated = latest.lastResult === resultFingerprint ? latest.repeated + 1 : 1;
      latest.lastResult = resultFingerprint;
    } else {
      latest.repeated = 0;
      delete latest.lastResult;
    }
    if (latest.rounds >= P.MAX_ROUNDS || latest.failures >= 3 ||
      latest.repeated >= 3 || ["cancelled", "interrupted"].includes(result.status)) latest.pause = true;
    await save(sessions);
    badge(session.tabId, result.status === "approval" ? "!" : "");
    return pageState(latest, true);
  });
}

async function revokeBridge(grant) {
  try { await bridgeRequest(grant, { type: "chat.disconnect" }); }
  catch (error) {
    if (error.code !== "BRIDGE_RECONNECT") {
      throw new BridgeError("无法确认旧侧栏任务已停止，已保留原连接。请检查本机 Navi 后重试。");
    }
  }
}

async function persistSettings(current, next) {
  if (current.bridge && current.bridge.grantId !== next.bridge?.grantId) await revokeBridge(current.bridge);
  const sessions = await load();
  for (const session of [...sessions]) removeSession(sessions, session.tabId);
  await save(sessions);
  await chrome.storage.local.set({ [CONFIG]: next });
  if (cached) {
    if (next.token === current.token) cached.revision = next.revision;
    else cached = null;
  }
}

async function configure(message) {
  return serial(async () => {
    const current = await settings();
    const raw = typeof message.token === "string" ? message.token.trim() : "";
    const token = message.clear === true ? null : (raw || current.token);
    if (token && !P.validToken(token)) fail("请输入 Nexus 普通 MCP Token（lb_ 加 64 位小写十六进制）。");
    const projectId = typeof message.projectId === "string" ? message.projectId.trim() : current.projectId;
    if (projectId && !validProjectId(projectId)) fail("项目 ID 格式无效。");
    const paired = current.paired === true && token === current.token;
    if (paired && projectId !== current.projectId) fail("配对项目不能在高级设置中改写，请通过 Navi 更换项目。");
    const selectable = paired ? READ_TOOLS : P.TOOL_NAMES;
    const selected = current.token !== token ? [] :
      (Array.isArray(message.selected) ? selectable.filter((name) => message.selected.includes(name)) : current.selected);
    if (selected.some((name) => !cached?.tools.some((tool) => tool.name === name) && !current.selected.includes(name))) {
      fail("请连接 Nexus 获取实际工具列表后再选择。");
    }
    if (token === current.token && projectId === current.projectId &&
      P.canonical(selected) === P.canonical(current.selected)) return pairingView();
    const next = { ...(paired ? current : {}), token, projectId, selected, revision: crypto.randomUUID() };
    if (paired && Array.isArray(message.selected)) next.autoSelect = false;
    await persistSettings(current, next);
    await chrome.storage.session.remove(PAIR);
    return pairingView();
  });
}

async function selectReadDefaults(config, fresh = false) {
  const connection = await clientFor(config, AbortSignal.timeout(9000), fresh);
  if (!config.paired || !config.autoSelect) return config;
  return serial(async () => {
    const current = await settings();
    if (current.revision !== config.revision) fail("连接已变化，请重试。");
    const selected = READ_TOOLS.filter((name) => connection.tools.some((tool) => tool.name === name));
    if (!selected.length) fail("本机 Nexus 暂未提供此扩展支持的只读工具。");
    const next = { ...current, selected, autoSelect: false };
    await chrome.storage.local.set({ [CONFIG]: next });
    return next;
  });
}

async function beginPairing() {
  return pairingOperation(async () => {
    const config = await settings();
    let record = await pairRecord();
    if (!isPending(record, config)) {
      const verifier = newVerifier();
      const started = await startPair(verifier);
      record = { ...started, verifier, revision: config.revision };
      await serial(async () => {
        if ((await settings()).revision !== config.revision) fail("连接已变化，请重试。");
        await chrome.storage.session.set({ [PAIR]: record });
      });
    }
    // The browser receives the public request ID only. Rebuild the fixed URL
    // rather than opening any extension message or server-provided URL.
    await chrome.tabs.create({ url: approvalUrl(record.requestId) });
    return pairingView("pending");
  });
}

async function resumePairing(requestId = null) {
  return pairingOperation(async () => {
    const config = await settings();
    const record = await pairRecord();
    if (requestId !== null && record?.requestId !== requestId) return null;
    if (!isPending(record, config)) {
      if (record) await chrome.storage.session.remove(PAIR);
      return pairingView(record?.revision === config.revision ? "expired" : "idle");
    }
    const state = await statusPair(record);
    if (state === "pending") return pairingView();
    if (state !== "approved") {
      await chrome.storage.session.remove(PAIR);
      return pairingView(state);
    }
    // Hold the settings queue for the bounded one-time exchange, so manual
    // configuration cannot be replaced by an approval already in flight.
    const paired = await serial(async () => {
      const current = await settings();
      if (!isPending(record, current) || (await pairRecord())?.requestId !== record.requestId) return null;
      const grant = await exchangePair(record);
      const next = { token: grant.token, projectId: grant.projectId, projectName: grant.projectName,
        bridge: bridgeGrant(grant.bridge), paired: true, tokenExpiresAt: grant.expiresAt, selected: [], autoSelect: true, revision: crypto.randomUUID() };
      try { await persistSettings(current, next); }
      catch (error) {
        if (next.bridge) void revokeBridge(next.bridge).catch(() => {});
        await chrome.storage.session.remove(PAIR);
        throw error;
      }
      await chrome.storage.session.remove(PAIR);
      return next;
    });
    if (!paired) return pairingView();
    // Save the grant before the tools request: a transient Nexus outage must
    // not lose a ticket already consumed by the Workbench.
    try { await selectReadDefaults(paired); }
    catch { return pairingView("tools-unavailable"); }
    return pairingView("connected");
  });
}

const browserJobs = new Map();
function resumeBrowser(grant, run) {
  const callId=run?.browserAction?.callId;
  if (!callId || run.status!=="running") return;
  const key="navi.browser.receipt."+grant.grantId+"."+run.runId+"."+callId;
  if (browserJobs.has(key)) return;
  const task=(async()=>{
    let receipt=(await chrome.storage.session.get(key))[key];
    if (!receipt) {
      const claimed=await bridgeRequest(grant,{type:"chat.browser.claim",runId:run.runId,callId});
      if (claimed.callId!==callId || !claimed.args) throw new Error("浏览器任务不匹配。");
      // Persist before side effects; after a worker interruption never replay a click.
      receipt={ok:false,uncertain:true,message:"浏览器执行曾中断，结果未知；请检查标签页，不要自动重试。"};
      await chrome.storage.session.set({[key]:receipt});
      try {
        if ((await settings()).bridge?.grantId!==grant.grantId) throw new Error("连接已更换，未执行浏览器操作。");
        const current=await bridgeRequest(grant,{type:"chat.events",runId:run.runId,after:0});
        if (current.run?.status!=="running" || current.run.browserAction?.callId!==callId) throw new Error("任务已停止，未执行浏览器操作。");
        receipt=await executeBrowser(chrome,grant.grantId,claimed.args);
      } catch(error) { receipt={ok:false,...(error.uncertain?{uncertain:true}:{}),message:redactBridge(String(error.message || "浏览器操作失败。")).slice(0,500)}; }
      await chrome.storage.session.set({[key]:receipt});
    }
    await bridgeRequest(grant,{type:"chat.browser.result",runId:run.runId,callId,result:receipt});
    await chrome.storage.session.remove(key);
  })().catch(()=>{}).finally(()=>browserJobs.delete(key));
  browserJobs.set(key,task);
}

async function handleChat(message) {
  // Browser results and claims are generated only by this worker, never by a UI message.
  if (message.type.startsWith("chat.browser.")) fail("浏览器执行接口仅供后台使用。");
  const config = await serial(settings);
  if (currentMode(config)==="direct") return engine().handle(message);
  const grant = bridgeGrant(config.bridge);
  if (!grant) throw new BridgeError("请通过 Navi 配对来连接侧栏。", "BRIDGE_RECONNECT");
  const result = await bridgeRequest(grant, message);
  if (message.type === "chat.disconnect") {
    await serial(async () => {
      const current = await settings();
      if (current.bridge?.grantId === grant.grantId) {
        await chrome.storage.local.set({ [CONFIG]: { ...current, bridge: null } });
      }
    });
  } else {
    if ((await settings()).bridge?.grantId !== grant.grantId) {
      throw new BridgeError("侧栏连接已更换，请重新加载项目。", "BRIDGE_RECONNECT");
    }
    if (message.type === "chat.context" && result.project?.id !== config.projectId) {
      throw new BridgeError("侧栏连接返回的项目不匹配，请重新连接 Navi。", "BRIDGE_RECONNECT");
    }
  }
  if (message.type === "chat.events") resumeBrowser(grant,result.run);
  if (message.type === "chat.runs") for (const run of result.runs ?? []) resumeBrowser(grant,run);
  return result;
}

async function directSettings(message) {
  return serial(async()=>{
    const current=await settings();
    await engine().ready;
    if (engine().active()) fail("请先停止或完成独立对话，再更换模型设置。");
    if (message.type==="popup.direct.save") {
      const baseUrl=modelBaseUrl(message.baseUrl);
      const key=typeof message.key==="string" && message.key.trim() ? message.key.trim() : baseUrl===directConfig?.baseUrl ? directConfig.key : "";
      if (!key || key.length>8192 || /[\r\n\u0000]/.test(key)) fail("请输入有效 API Key；更换服务地址时需要重新填写。");
      if (!(await chrome.permissions.contains({origins:[new URL(baseUrl).origin+"/*"]}))) fail("请先允许访问该模型服务地址。");
      let models;
      try {models=await new DirectApi({baseUrl,key}).models();} catch(error){throw new Error(cleanDirect(error.message,key));}
      const selected=message.defaultModel || models[0].id;
      if (!models.some(model=>model.id===selected)) fail("默认模型不在服务返回的列表中。");
      const next={baseUrl,key,models,defaultModel:selected,revision:crypto.randomUUID()};
      await engine().reset();
      await chrome.storage.local.set({[DIRECT]:next,[MODE]:"direct"});directConfig=next;chatMode="direct";
    } else if (message.type==="popup.direct.clear") {
      await engine().reset();await chrome.storage.local.remove(DIRECT);await chrome.storage.local.set({[MODE]:"direct"});directConfig=null;chatMode="direct";
    } else if (message.type==="popup.chat.mode") {
      if (!["direct","navi"].includes(message.mode)) fail("模型连接模式无效。");
      await chrome.storage.local.set({[MODE]:message.mode});chatMode=message.mode;
    }
    return pairingView();
  });
}

async function handlePanel(message) {
  switch (message.type) {
    case "popup.direct.save":
    case "popup.direct.clear":
    case "popup.chat.mode": return directSettings(message);
    case "popup.config": return await serial(() => pairingView());
    case "popup.pair.start": return await beginPairing();
    case "popup.pair.status": return await resumePairing();
    case "popup.save": return await configure(message);
    case "popup.check": {
      const config = await serial(settings);
      await selectReadDefaults(config, true);
      return pairingView();
    }
    case "popup.protocol": {
      const config = await serial(settings);
      if (!config.projectId || !config.selected.length) fail("请先连接 Navi 并启用可用工具。");
      const connection = await clientFor(config);
      if ((await settings()).revision !== config.revision) fail("配置已变化。");
      const tools = connection.tools.filter((tool) => config.selected.includes(tool.name) &&
        (!config.paired || READ_TOOLS.includes(tool.name)));
      if (!tools.length) fail("Nexus 未提供选定工具，请刷新工具列表。");
      return { prompt: P.prompt(config.projectId, tools) };
    }
    case "popup.inspect":
      return await serial(async () => {
        if (!Number.isInteger(message.tabId)) return pageState(null);
        const sessions = await load();
        const session = findSession(sessions, message.tabId);
        if (!session || await tabRoute(message.tabId) !== session.route) return pageState(null);
        if (expire(session)) await save(sessions);
        return pageState(session, true);
      });
    case "popup.retry":
    case "popup.execute": return await execute(message);
    case "popup.reject":
    case "popup.cancel":
      return await serial(async () => {
        const sessions = await load();
        const session = findSession(sessions, message.tabId);
        const entry = session?.entry;
        if (!entryMatches(session, entry, message)) fail("找不到此请求。");
        if (message.type === "popup.reject" && entry.status === "pending") {
          entry.status = "rejected";
          entry.text = "此请求未执行。";
          badge(session.tabId, "");
          await save(sessions);
        } else if (message.type === "popup.cancel" && entry.status === "running") {
          running.get(session.tabId)?.controller.abort();
        }
        return pageState(session, true);
      });
    default: fail("未知的侧栏操作。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== "string") return false;
  const chat = message.type.startsWith("chat.");
  const panel = chat || message.type.startsWith("popup.");
  if (!panel && !message.type.startsWith("page.")) return false;
  (async () => {
    await ready;
    const page = source(sender, panel ? "popup" : "page");
    return chat ? handleChat(message) : panel ? handlePanel(message) : handlePage(message, page);
  })().then((data) => reply({ ok: true, data })).catch((error) => {
    reply({ ok: false, error: redactBridge(cleanDirect(String(error.message || "扩展请求失败。"),directConfig?.key)).slice(0, 400),
      ...(error instanceof BridgeError || ["DIRECT_REQUEST","DIRECTORY_PERMISSION"].includes(error.code) ? { code: error.code } : {}) });
  });
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (!approvedNotification(message, sender)) return false;
  void ready.then(() => resumePairing(message.requestId)).then(
    (view) => reply({ ok: Boolean(view) }), () => reply({ ok: false }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serial(async () => {
    const sessions = await load();
    if (findSession(sessions, tabId)) {
      removeSession(sessions, tabId);
      await save(sessions);
    }
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== "loading") return;
  void serial(async () => {
    const sessions = await load();
    const session = findSession(sessions, tabId);
    if (session && (change.status === "loading" || P.siteUrl(change.url) !== session.route)) {
      removeSession(sessions, tabId);
      await save(sessions);
    }
  }).catch(() => {});
});
