import { AppError, cleanCode, cleanMessage, isObject, wireFetch, jsonWire, parseWireJson, signalWith, textOutput, readText } from './net.mjs';

const PROTOCOL = '2026-07-28';
// Select the fixed upstream's native MCP handler. It still checks bearer token and scopes.
const headerBase = {
  'content-type': 'application/json', accept: 'application/json, text/event-stream',
  'x-nexus-internal': 'true', 'mcp-protocol-version': PROTOCOL
};
const READ = new Set([
  'project_info', 'directory_list', 'file_stat', 'file_read', 'fs_search', 'fs_grep',
  'git_status', 'git_diff', 'command_classify'
]);
const WRITE = new Set(['file_create', 'file_write', 'file_patch', 'fs_mkdir', 'command_run']);
const SESSIONS = new Set(['session_list', 'session_events', 'session_status']);
export function riskFor(name) {
  if (!name?.startsWith('localbridge_')) return null;
  const short = name.slice(12);
  if (READ.has(short)) return 'read';
  if (WRITE.has(short)) return short === 'command_run' ? 'command' : 'write';
  return null;
}
export function safeMcpName(name) {
  return Boolean(riskFor(name)) || name === 'localbridge_project_list'
    || (name?.startsWith('localbridge_') && SESSIONS.has(name.slice(12)));
}

export class Nexus {
  id = 0;
  constructor({ url, token, managementToken }) {
    this.url = url;
    this.base = new URL(url).origin;
    this.token = token;
    this.managementToken = managementToken;
  }
  upstreamError(message, status, code, fallback) {
    const secrets = [this.token, this.managementToken];
    return new AppError(cleanMessage(message, secrets) || ('Nexus HTTP ' + status),
      status, cleanCode(code, secrets, fallback));
  }
  async rpc(method, params, { signal, execution, timeout = 18_000 } = {}) {
    if (!this.token) throw new AppError('Nexus MCP Token 未配置。', 503, 'NEXUS_TOKEN_MISSING');
    const id = ++this.id;
    const headers = { ...headerBase, authorization: 'Bearer ' + this.token, 'mcp-method': method };
    if (method === 'tools/call') headers['mcp-name'] = params.name;
    if (execution) {
      headers['x-nexus-task-id'] = execution.runId;
      headers['x-nexus-execution-id'] = execution.id;
      headers['x-nexus-idempotency-key'] = execution.id;
    }
    const response = await wireFetch(this.url, {
      method: 'POST', headers, signal: signalWith(signal, timeout),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: {
        ...params,
        _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} }
      } })
    });
    let envelope;
    const media = response.headers.get('content-type') ?? '';
    if (media.includes('text/event-stream')) {
      const body = await readText(response.body, 3_000_000);
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const candidate = parseWireJson(line.slice(5).trim());
        if (candidate.id === id) envelope = candidate;
      }
    } else {
      envelope = await jsonWire(response, 3_000_000);
    }
    if (response.status >= 500 && method === 'tools/call' && !envelope?.error) {
      throw new AppError('Nexus 上游未确认执行结果。', 502, 'NEXUS_UNCERTAIN');
    }
    if (!response.ok || envelope?.error) {
      const message = envelope?.error?.message ?? envelope?.message
        ?? (typeof envelope?.error === 'string' ? envelope.error : null);
      const serverCode = envelope?.error?.data?.code ?? envelope?.code;
      throw this.upstreamError(message, response.ok ? 502 : response.status, serverCode, 'NEXUS_RPC');
    }
    if (envelope?.id !== id || !isObject(envelope?.result)) {
      throw new AppError('Nexus 未返回匹配的 JSON-RPC 响应。', 502, 'NEXUS_PROTOCOL');
    }
    return envelope.result;
  }
  async listTools(signal) {
    const all = new Map(), seen = new Set();
    let cursor;
    do {
      const page = await this.rpc('tools/list', cursor ? { cursor } : {}, { signal });
      if (!Array.isArray(page.tools)) throw new AppError('Nexus 工具目录格式无效。', 502);
      for (const tool of page.tools) {
        if (safeMcpName(tool?.name) && isObject(tool.inputSchema)) all.set(tool.name, tool);
      }
      cursor = page.nextCursor;
      if (cursor && (typeof cursor !== 'string' || seen.has(cursor) || seen.size > 40)) {
        throw new AppError('Nexus 工具目录分页无效。', 502);
      }
      seen.add(cursor);
    } while (cursor);
    return all;
  }
  call(name, args, opts = {}) {
    if (!safeMcpName(name)) throw new AppError('工具不在工作台允许列表。');
    return this.rpc('tools/call', { name, arguments: args }, { timeout: 45_000, ...opts });
  }
  async projects(signal) {
    const result = await this.call('localbridge_project_list', {}, { signal, timeout: 8_000 });
    const data = textOutput(result);
    if (result.isError || !Array.isArray(data?.projects)) throw new AppError('无法读取 Nexus 项目。', 502);
    if (data.safetyLayerDisabled !== false) throw new AppError('请在 Nexus 启用安全层后再运行。', 409, 'NEXUS_SAFETY');
    return data.projects.filter(p => !p.isDrive && !String(p.id).startsWith('drive-')).map(projectView);
  }
  async manage(route, { method = 'GET', body, signal } = {}) {
    if (!this.managementToken) throw new AppError('Nexus 管理连接未配置。', 503, 'NEXUS_ADMIN_MISSING');
    const response = await wireFetch(this.base + route, {
      method, signal: signalWith(signal, 9_000), headers: {
        authorization: 'Bearer ' + this.managementToken, accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await jsonWire(response);
    if (!response.ok) throw this.upstreamError(data?.message || data?.error, response.status, data?.code, 'NEXUS_MANAGEMENT');
    return data;
  }
  async runners(signal) {
    const list = await this.manage('/api/runners', { signal });
    if (!Array.isArray(list)) throw new AppError('Runner 列表格式无效。', 502);
    return list.map(r => ({ id: r.id, name: r.name || r.runnerName || 'Local Runner' }));
  }
  async approvals() {
    const runners = await this.runners();
    const rows = await Promise.all(runners.map(async runner => {
      const value = await this.manage('/api/approvals?runnerId=' + encodeURIComponent(runner.id));
      return Array.isArray(value?.approvals) ? value.approvals.map(a => approvalView(a, runner.id)) : [];
    }));
    return rows.flat().sort((a, b) => b.createdAt - a.createdAt);
  }
  approval(id, runnerId, signal) {
    return this.manage('/api/approvals/' + encodeURIComponent(id) + (runnerId ? '?runnerId=' + encodeURIComponent(runnerId) : ''), { signal });
  }
  async resolveApproval(id, action, runnerId) {
    const value = await this.manage('/api/approvals/' + encodeURIComponent(id) + '/resolve', {
      method: 'POST', body: { action, runnerId, resolvedBy: 'Workbench operator', decisionSource: 'desktop' }
    });
    return approvalView(value, runnerId);
  }
}

export function projectView(p) {
  return { id: p.id, name: p.name ?? p.id, runnerId: p.runnerId,
    accessMode: p.accessMode, executionMode: p.executionMode, enabled: p.enabled !== false };
}
function approvalView(a, runnerId) {
  return { id: a.id, projectId: a.projectId, operation: a.operation, risk: a.risk, summary: a.summary,
    status: a.status, createdAt: a.createdAt, expiresAt: a.expiresAt, resolvedAt: a.resolvedAt, runnerId };
}

// Nexus can wrap a Runner LocalBridgeError as a JSON-RPC RemoteRpcError.
export function approvalRequired(result) {
  if (!result?.isError) return null;
  const s = result.structuredContent;
  if (!isObject(s)) return null;
  const candidates = [s, s.details, s.data, s.data?.details, s.data?.data, s.data?.data?.details];
  const isRequired = [s.code, s.remoteCode, ...candidates.map(v => v?.code)].includes('APPROVAL_REQUIRED');
  if (!isRequired) return null;
  const idPattern = /^approval_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const details = candidates.find(v => typeof v?.approvalId === 'string' && idPattern.test(v.approvalId));
  if (details) return { id:details.approvalId, summary:details.summary, expiresAt:details.expiresAt };
  // The locked Runner can redact error details down to {code}. Recognize only
  // its approval marker, then RunManager verifies the actual record and project.
  const marker = result.content?.find(part=>part.type==='text')?.text?.match(/Approval request "(approval_[0-9a-f-]{36})"/i)?.[1];
  return marker && idPattern.test(marker) ? {id:marker} : null;
}
