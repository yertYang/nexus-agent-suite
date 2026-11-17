// SPDX-License-Identifier: GPL-3.0-only
import "./protocol.js";

const P = globalThis.NexusProtocol;
export const WORKBENCH = "http://127.0.0.1:17880";
export const PAIR_TTL = 120_000;
export const pairId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const projectId = (value) => typeof value === "string" &&
  /^[a-zA-Z0-9_.:-]{1,180}$/.test(value) && !P.containsToken(value);
export const READ_TOOLS = Object.freeze([
  "project_info", "directory_list", "file_stat", "file_read", "fs_search", "fs_grep", "git_status", "git_diff",
].map((name) => "localbridge_" + name));
const MAX_RESPONSE = 8192;
const PAIR_TIMEOUT = 6500;
// Workbench may spend up to 8s checking the project and another 9s minting the grant.
const EXCHANGE_TIMEOUT = 22_000;

export function newVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function approvalUrl(requestId) {
  if (!pairId(requestId)) throw new Error("无效的 Navi 配对请求。");
  return WORKBENCH + "/#extension-pair=" + requestId;
}

export function approvedNotification(message, sender) {
  if (!P.object(message) || Object.keys(message).length !== 2 ||
    message.type !== "navi.pair.approved" || !pairId(message.requestId) ||
    (sender?.frameId !== undefined && sender.frameId !== 0) ||
    (sender?.origin !== undefined && sender.origin !== WORKBENCH)) return false;
  try {
    const url = new URL(sender?.url);
    return url.origin === WORKBENCH && !url.username && !url.password;
  } catch {
    return false;
  }
}
async function boundedJson(response) {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE) {
    throw new Error("Navi 配对响应无效。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let data = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE) throw new Error("Navi 配对响应过大。");
      data += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(data + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function post(route, body, fetcher) {
  let response;
  try {
    response = await fetcher(WORKBENCH + "/api/extension/pair/" + route, {
      method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(route === "exchange" ? EXCHANGE_TIMEOUT : PAIR_TIMEOUT),
    });
  } catch {
    throw new Error("没有连接到本机 Navi。请先双击 Navi.app，再试一次。");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("此 Navi Link 安装未获本机配对许可。请从 Navi 套件加载扩展，或使用高级设置。");
    }
    if (response.status === 404) throw new Error("Navi 暂未提供该配对请求。请确认已启动当前版本，然后重新连接。");
    if (response.status === 429) throw new Error("尝试次数过多。等一会儿再连接 Navi。");
    if (response.status === 409 || response.status === 410) throw new Error("配对请求已失效。请重新连接 Navi。");
    throw new Error("Navi 未能处理配对请求。请稍后重试。");
  }
  try {
    const value = await boundedJson(response);
    if (!P.object(value)) throw new TypeError();
    return value;
  } catch {
    throw new Error("Navi 返回了无效的配对响应。");
  }
}
function auth(pending) {
  if (!pairId(pending?.requestId) || !pairId(pending?.verifier)) throw new Error("没有可继续的 Navi 配对请求。");
  return { requestId: pending.requestId, verifier: pending.verifier };
}
const platformFetch = (...args) => globalThis.fetch(...args);
export async function startPair(verifier, fetcher = platformFetch, now = Date.now) {
  if (!pairId(verifier)) throw new Error("配对校验信息无效。");
  const value = await post("start", { challenge: await P.hash(verifier) }, fetcher);
  const url = approvalUrl(value.requestId);
  const ts = now();
  if (value.approvalUrl !== url || !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= ts || value.expiresAt > ts + PAIR_TTL) {
    throw new Error("Navi 返回了无效的本机配对入口。");
  }
  return { requestId: value.requestId, expiresAt: value.expiresAt, approvalUrl: url };
}
export async function statusPair(pending, fetcher = platformFetch) {
  const value = await post("status", auth(pending), fetcher);
  if (!["pending", "approved", "denied", "expired", "consumed"].includes(value.state) ||
    !Number.isSafeInteger(value.expiresAt) || Object.hasOwn(value, "token")) {
    throw new Error("Navi 返回了无效的配对状态。");
  }
  return value.state;
}
export async function exchangePair(pending, fetcher = platformFetch, now = Date.now) {
  const grant = await post("exchange", auth(pending), fetcher);
  if (!P.validToken(grant.token) || grant.endpoint !== P.ENDPOINT ||
    !Array.isArray(grant.scopes) || grant.scopes.length !== 1 || grant.scopes[0] !== "read" ||
    !projectId(grant.project?.id) || typeof grant.project?.name !== "string" ||
    !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now()) {
    throw new Error("Navi 返回的工具授权无效。");
  }
  return { token: grant.token, projectId: grant.project.id,
    projectName: P.redact(grant.project.name.trim()).slice(0, 160) || "Navi 项目",
    expiresAt: grant.expiresAt, ...(Object.hasOwn(grant, "bridge") ? { bridge: grant.bridge } : {}) };
}
