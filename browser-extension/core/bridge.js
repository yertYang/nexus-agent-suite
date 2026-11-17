// SPDX-License-Identifier: GPL-3.0-only
import { WORKBENCH } from "./pair.js";

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bridgePattern = /^nvl_[A-Za-z0-9_-]{43}$/;
const modelPattern = /^[^\u0000-\u001f\u007f]{1,150}$/;
const callPattern = /^[A-Za-z0-9_.:-]{1,180}$/;
const MAX_BODY = 2_000_000;
const asObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const validId = (id) => typeof id === "string" && idPattern.test(id);
const validModel = (id) => typeof id === "string" && modelPattern.test(id);

export class BridgeError extends Error {
  constructor(message, code = "BRIDGE_UNAVAILABLE") {
    super(message);
    this.code = code;
  }
}

export function bridgeGrant(value, now = Date.now()) {
  if (!asObject(value) || typeof value.token !== "string" || !bridgePattern.test(value.token) ||
      !validId(value.grantId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) return null;
  return { token: value.token, grantId: value.grantId, expiresAt: value.expiresAt };
}

function invalid() { throw new BridgeError("侧栏请求参数无效。", "BRIDGE_INVALID"); }
function runId(message, field = "runId") {
  if (!validId(message[field])) invalid();
  return message[field];
}

export function bridgeOperation(message) {
  switch (message.type) {
    case "chat.context": return { path: "/context/read", body: {} };
    case "chat.runs": return { path: "/runs/list", body: {} };
    case "chat.events": {
      if (!Number.isSafeInteger(message.after) || message.after < 0) invalid();
      return { path: "/runs/" + runId(message) + "/events/read", body: { after: message.after } };
    }
    case "chat.create": {
      const prompt = typeof message.prompt === "string" ? message.prompt.trim() : "";
      if (!prompt || prompt.length > 16_000 || !validModel(message.model)) invalid();
      const body = { prompt, model: message.model, clientRequestId: runId(message, "clientRequestId") };
      if (Object.hasOwn(message,"projectSelected")) { if (typeof message.projectSelected!=="boolean") invalid(); body.projectSelected=message.projectSelected; }
      if (message.previousRunId != null) body.previousRunId = runId(message, "previousRunId");
      return { path: "/runs", body };
    }
    case "chat.decision":
      if (typeof message.callId !== "string" || !callPattern.test(message.callId) ||
          !["approve", "deny"].includes(message.decision)) invalid();
      return {
        path: "/runs/" + runId(message) + "/decisions",
        body: { callId: message.callId, decision: message.decision },
      };
    case "chat.browser.claim":
    case "chat.browser.result":
      if (typeof message.callId !== "string" || !callPattern.test(message.callId)) invalid();
      if (message.type.endsWith("result") && (!asObject(message.result) || typeof message.result.ok !== "boolean" || JSON.stringify(message.result).length > 32000)) invalid();
      return { path: "/runs/" + runId(message) + (message.type.endsWith("claim") ? "/browser/claim" : "/browser/result"),
        body: { callId: message.callId, ...(message.type.endsWith("result") ? { result: message.result } : {}) } };
    case "chat.artifact":
      return { path: "/runs/" + runId(message) + "/artifacts/" + runId(message, "artifactId") + "/read", body: {} };
    case "chat.cancel": return { path: "/runs/" + runId(message) + "/cancel", body: {} };
    case "chat.disconnect": return { path: "/disconnect", body: {} };
    default: return invalid();
  }
}

async function jsonResponse(response) {
  if (!response.body) return {};
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_BODY) throw new BridgeError("Navi 返回的消息过大。");
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let value = "", size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) throw new BridgeError("Navi 返回的消息过大。");
      value += decoder.decode(part.value, { stream: true });
    }
    const parsed = JSON.parse(value + decoder.decode());
    if (!asObject(parsed)) throw new Error();
    return parsed;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function redactBridge(value) {
  const { redact } = globalThis.NexusProtocol;
  return redact(value).replace(/nvl_[A-Za-z0-9_-]{43}/g, "[已隐藏授权]");
}

const platformFetch = (...args) => globalThis.fetch(...args);

export async function bridgeRequest(grant, message, fetcher = platformFetch) {
  const { path, body } = bridgeOperation(message);
  if (!bridgeGrant(grant)) throw new BridgeError("侧栏连接已到期，请重新连接 Navi。", "BRIDGE_RECONNECT");
  let response;
  try {
    response = await fetcher(WORKBENCH + "/api/extension/bridge" + path, {
      // Privileged Chromium extension GETs may omit Origin. Every bridge
      // operation uses POST so the server can require the exact Origin.
      mode: "cors", method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", Authorization: "Bearer " + grant.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(24_000),
    });
  } catch {
    throw new BridgeError("无法连接本机 Navi。请先启动 Navi 工作台。");
  }
  if (response.status === 401) throw new BridgeError("侧栏连接已失效，请重新连接 Navi。", "BRIDGE_RECONNECT");
  let result;
  try { result = await jsonResponse(response); }
  catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("Navi 未返回有效的侧栏响应。");
  }
  if (!response.ok) {
    const code = result.error?.code === "MODEL_NOT_CONFIGURED" ? "MODEL_NOT_CONFIGURED" :
      response.status === 409 ? "BRIDGE_CONFLICT" : response.status >= 500 ? "BRIDGE_UNAVAILABLE" : "BRIDGE_REQUEST_FAILED";
    const message = typeof result.error?.message === "string"
      ? redactBridge(result.error.message).slice(0, 400) : "Navi 未能处理侧栏请求。";
    throw new BridgeError(message, code);
  }
  if (message.type === "chat.artifact") {
    if (result.mime !== "image/jpeg" || typeof result.base64 !== "string" || result.base64.length > 28_000 ||
      !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) throw new BridgeError("Navi 未返回有效的测试截图。");
    return { mime: result.mime, base64: result.base64 };
  }
  if (message.type === "chat.disconnect" && result.ok !== true) {
    throw new BridgeError("Navi 未确认侧栏断开。");
  }
  // Responses contain only records for the approved grant; prevent accidental relay
  // of either extension credential even if returned through a model or tool event.
  return JSON.parse(redactBridge(JSON.stringify(result)));
}
