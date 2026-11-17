// SPDX-License-Identifier: GPL-3.0-only
import "./protocol.js";

const { ENDPOINT, TOOL_NAMES, object, validToken, redact } = globalThis.NexusProtocol;
export const NEXUS_VERSION = "2026-07-28";
const LEGACY = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);
const CLIENT_INFO = Object.freeze({ name: "qizhou-web-companion", version: "1.0.0" });
const BODY_LIMIT = 4 * 1024 * 1024;

export class McpError extends Error {
  constructor(message, { status = 0, data, code, definite = false } = {}) {
    super(message);
    this.name = "McpError";
    this.status = status;
    this.data = data;
    this.code = code;
    this.definite = definite;
  }
}

async function readBody(response, inspect) {
  const reader = response.body?.getReader();
  if (!reader) return inspect("", true);
  const decoder = new TextDecoder();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      size += part.value?.byteLength ?? 0;
      if (size > BODY_LIMIT) throw new McpError("Nexus 响应超过 4 MiB。");
      const text = part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      const result = inspect(text, part.done);
      if (result !== undefined || part.done) return result;
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function answerFrom(payload, id) {
  return (Array.isArray(payload) ? payload : [payload]).find((item) =>
    item?.jsonrpc === "2.0" && item.id === id &&
    (Object.hasOwn(item, "result") || Object.hasOwn(item, "error")));
}

export async function responseMessage(response, id) {
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    let remaining = "";
    let data = [];
    function event() {
      const lines = data;
      data = [];
      if (!lines.length) return;
      try { return answerFrom(JSON.parse(lines.join("\n")), id); }
      catch { return undefined; }
    }
    return readBody(response, (text, done) => {
      remaining += text;
      let n;
      while ((n = remaining.indexOf("\n")) !== -1) {
        const line = remaining.slice(0, n).replace(/\r$/, "");
        remaining = remaining.slice(n + 1);
        if (!line) {
          const answer = event();
          if (answer !== undefined) return answer;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (done) {
        if (remaining.startsWith("data:")) data.push(remaining.slice(5).replace(/^ /, ""));
        return event();
      }
    });
  }
  let text = "";
  return readBody(response, (part, done) => {
    text += part;
    if (done && text) {
      try { return answerFrom(JSON.parse(text), id); }
      catch { return undefined; }
    }
  });
}

export class McpClient {
  #token;
  #fetch;
  #id = 0;
  #version = null;
  #session = null;
  #ready = false;

  constructor(token, fetcher = (...args) => globalThis.fetch(...args)) {
    if (!validToken(token)) throw new McpError("请先在扩展弹窗配置 Nexus MCP Token。");
    this.#token = token;
    this.#fetch = fetcher;
  }
  get version() { return this.#version; }

  async #post(method, params = {}, { signal, notification = false, key, timeout = 15_000,
    version = this.#version } = {}) {
    const id = notification ? undefined : ++this.#id;
    const headers = {
      Authorization: "Bearer " + this.#token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Nexus-Internal": "true",
      "Mcp-Method": method,
    };
    if (version) headers["Mcp-Protocol-Version"] = version;
    if (this.#session) headers["Mcp-Session-Id"] = this.#session;
    if (method === "tools/call") headers["Mcp-Name"] = params.name;
    if (key) headers["X-Nexus-Idempotency-Key"] = key;
    if (version === NEXUS_VERSION && !notification) {
      params = { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        "io.modelcontextprotocol/clientCapabilities": {},
      } };
    }
    const deadline = AbortSignal.timeout(timeout);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    let answer;
    try {
      response = await this.#fetch(ENDPOINT, {
        method: "POST", headers, credentials: "omit", redirect: "error", cache: "no-store",
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: requestSignal,
      });
      if (!response.ok || !notification) answer = await responseMessage(response, id);
      else void response.body?.cancel().catch(() => {});
    } catch (error) {
      if (signal?.aborted) throw new McpError("已停止等待 Nexus 响应。");
      if (deadline.aborted) throw new McpError("等待 Nexus 响应超时。");
      if (error instanceof McpError) throw error;
      throw new McpError("无法连接本机 Nexus，或服务器尝试重定向。");
    }
    if (!response.ok) {
      let message = "Nexus 返回 HTTP " + response.status + "。";
      if (response.status === 401) message = "Nexus MCP Token 无效、过期或已撤销。";
      if (response.status === 403) message = "Nexus 拒绝请求，请检查该工具对应的令牌权限。";
      if (response.status === 503) message = "Nexus 不可用或已暂停。";
      throw new McpError(message, { status: response.status, data: answer?.error?.data, code: answer?.error?.code,
        definite: [400, 401, 403, 404, 405, 413, 415, 429].includes(response.status) });
    }
    if (notification) return;
    if (answer?.error) {
      const message = typeof answer.error.message === "string" ? redact(answer.error.message).slice(0, 300) :
        "Nexus 返回 MCP 错误。";
      throw new McpError(message, { data: answer.error.data, code: answer.error.code,
        definite: [-32600, -32601, -32602, -32003].includes(answer.error.code) });
    }
    if (!answer) throw new McpError("Nexus 未返回与请求匹配的 MCP 响应。");
    if (method === "initialize") {
      const session = response.headers.get("mcp-session-id");
      if (session && !/^[!-~]{1,512}$/.test(session)) throw new McpError("MCP 会话标识无效。");
      this.#session = session;
    }
    return answer.result;
  }

  async initialize(signal) {
    if (this.#ready) return;
    let discovery;
    try {
      discovery = await this.#post("server/discover", {}, { signal, version: NEXUS_VERSION });
    } catch (error) {
      // Older Streamable HTTP servers may answer either Method Not Found or
      // an HTTP negotiation/validation refusal. Never retry through auth,
      // network failures, redirects or ambiguous transport errors.
      if (error.code !== -32601 && ![400, 404, 405, 406, 415].includes(error.status)) throw error;
    }
    if (discovery !== undefined) {
      if (!Array.isArray(discovery?.supportedVersions) || !discovery.supportedVersions.includes(NEXUS_VERSION)) {
        throw new McpError("Nexus 未公布扩展支持的 MCP 协议版本。");
      }
      this.#version = NEXUS_VERSION;
      this.#ready = true;
      return;
    }
    const info = await this.#post("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: CLIENT_INFO,
    }, { signal, version: null });
    if (!LEGACY.has(info?.protocolVersion)) throw new McpError("Nexus 返回了扩展不支持的 MCP 版本。");
    this.#version = info.protocolVersion;
    await this.#post("notifications/initialized", {}, { signal, notification: true });
    this.#ready = true;
  }

  async listTools(signal) {
    await this.initialize(signal);
    const found = new Map();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 30; page++) {
      const result = await this.#post("tools/list", cursor ? { cursor } : {}, { signal });
      if (!Array.isArray(result?.tools)) throw new McpError("Nexus 返回了无效的工具列表。");
      for (const tool of result.tools) {
        if (!TOOL_NAMES.includes(tool?.name) || !object(tool.inputSchema) || found.has(tool.name)) continue;
        // Only descriptor data needed to construct the prompt enters the popup.
        const safeSchema = redact(JSON.stringify(tool.inputSchema));
        if (safeSchema.length > 18_000) continue;
        found.set(tool.name, {
          name: tool.name,
          description: redact(String(tool.description ?? "")).slice(0, 1500),
          inputSchema: JSON.parse(safeSchema),
        });
      }
      cursor = result.nextCursor;
      if (cursor == null || cursor === "") return [...found.values()];
      if (typeof cursor !== "string" || cursor.length > 4096 || cursors.has(cursor)) {
        throw new McpError("Nexus 返回了重复或无效的分页标识。");
      }
      cursors.add(cursor);
    }
    throw new McpError("Nexus 工具列表超过 30 页。");
  }

  async approvalStatus(id, signal) {
    if (!/^approval_[0-9a-f-]{36}$/i.test(id)) throw new McpError("审批 ID 无效。");
    await this.initialize(signal);
    const result = await this.#post("tools/call", {
      name: "localbridge_approval_status", arguments: { approvalId: id },
    }, { signal });
    if (result?.isError || result?.structuredContent?.approvalId !== id) {
      throw new McpError("无法核实 Nexus 审批状态，请检查令牌是否有读取权限。");
    }
    return result.structuredContent.status;
  }

  async call(name, args, { signal, key, onDispatch } = {}) {
    if (!TOOL_NAMES.includes(name) || !object(args)) throw new McpError("工具未获授权。");
    await this.initialize(signal);
    if (signal?.aborted) throw new McpError("工具调用已取消。");
    onDispatch?.();
    return this.#post("tools/call", { name, arguments: args }, { timeout: 27_000, signal, key });
  }
}
