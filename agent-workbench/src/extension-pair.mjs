import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './net.mjs';

export const EXTENSION_ID = 'cldeocinpjaihjlapmhnefiefmalkbll';
export const EXTENSION_ORIGIN = 'chrome-extension://' + EXTENSION_ID;
export const EXTENSION_MCP = 'http://127.0.0.1:18080/mcp';
const pairId = /^[A-Za-z0-9_-]{43}$/;
const projectIdPattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const pairLifetime = 120_000;
const startWindow = 60_000;
const maxStarts = 16;
const tokenLifetime = 7 * 24 * 3600_000;
const digest = value => createHash('sha256').update(value).digest();
const missing = () => new AppError('找不到配对请求，请从 Navi Link 重新发起。', 404, 'PAIR_NOT_FOUND');
const invalidState = () => new AppError('配对请求已处理或过期，请从 Navi Link 重新发起。', 409, 'PAIR_STATE');
const exactBody = (body, key) => Object.keys(body).length === 1 && Object.hasOwn(body, key);

export function createExtensionPairing({ nexus, origin, enabled, issueBridge, now = Date.now }) {
  const records = new Map();
  let starts = [];
  const stateOf = record =>
    (record.state === 'pending' || record.state === 'approved') && record.expiresAt <= now() ? 'expired' : record.state;
  const publicState = record => ({ state:stateOf(record), expiresAt:record.expiresAt });
  function lookup(id) {
    if (typeof id !== 'string' || !pairId.test(id)) throw missing();
    const record = records.get(id);
    // Keep recent expired records briefly so clients can distinguish expiry from a bad verifier.
    if (!record || record.expiresAt + pairLifetime <= now()) throw missing();
    return record;
  }
  function authorize(body, caller) {
    if (Object.keys(body).length !== 2 || typeof body.verifier !== 'string' || !pairId.test(body.verifier)) throw missing();
    // Verifiers are encoded canonically; this also rejects aliases for a 32-byte buffer.
    if (Buffer.from(body.verifier, 'base64url').toString('base64url') !== body.verifier) throw missing();
    const record = lookup(body.requestId);
    if (record.extensionOrigin !== caller || !timingSafeEqual(record.challenge, digest(body.verifier))) throw missing();
    return record;
  }
  const assertPending = record => { if (stateOf(record) !== 'pending') throw invalidState(); };
  async function projectFor(id) {
    if (typeof id !== 'string' || !projectIdPattern.test(id)) throw new AppError('请选择已授权的项目。');
    // Nexus.projects() rejects a disabled safety layer and drops virtual drives.
    const project = (await nexus.projects(AbortSignal.timeout(8_000))).find(item => item.id === id
      && item.enabled === true && !item.isDrive && !id.startsWith('drive-')
      && ['read-only','read-write'].includes(item.accessMode));
    if (!project) throw new AppError('项目不可用。请检查项目授权后重新配对。', 409, 'PAIR_PROJECT_UNAVAILABLE');
    return project;
  }
  return {
    start(body, caller) {
      if (!enabled) throw new AppError('当前模式无法连接网页扩展。', 409, 'PAIR_UNAVAILABLE');
      if (caller !== EXTENSION_ORIGIN || !exactBody(body,'challenge') ||
        typeof body.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(body.challenge)) {
        throw new AppError('配对请求格式不正确。');
      }
      const startedAt = now();
      starts = starts.filter(time => time > startedAt - startWindow);
      let outstanding = 0;
      for (const [id,record] of records) {
        if (record.expiresAt + pairLifetime <= startedAt) records.delete(id);
        else if (['pending','approved'].includes(stateOf(record))) outstanding++;
      }
      if (starts.length >= maxStarts || outstanding >= maxStarts) {
        throw new AppError('配对请求过多，请稍后重试。', 429, 'PAIR_RATE_LIMIT');
      }
      const requestId = randomBytes(32).toString('base64url'), expiresAt = startedAt + pairLifetime;
      records.set(requestId,{ state:'pending',expiresAt,challenge:Buffer.from(body.challenge,'hex'),extensionOrigin:caller });
      starts.push(startedAt);
      return { requestId,expiresAt,approvalUrl:origin + '/#extension-pair=' + requestId };
    },
    status(body, caller) { return publicState(authorize(body,caller)); },
    inspect(id) { return { requestId:id,...publicState(lookup(id)),extensionId:EXTENSION_ID,capabilities:{splitAutomation:true} }; },
    async approve(id, body, sessionActive) {
      const access=Object.hasOwn(body,'access') ? body.access : 'read';
      if (!Object.hasOwn(body,'projectId') || Object.keys(body).some(key=>!['projectId','access','automation','browserAutomation','fileOperations'].includes(key)) ||
        (!['read','testing'].includes(access) || ['automation','browserAutomation','fileOperations'].some(key=>Object.hasOwn(body,key) && typeof body[key]!=='boolean') || (Object.hasOwn(body,'automation') && ['browserAutomation','fileOperations'].some(key=>Object.hasOwn(body,key))))) throw new AppError('请选择已授权的项目和连接权限。');
      const record = lookup(id);
      assertPending(record);
      const project = await projectFor(body.projectId);
      if (!sessionActive()) throw new AppError('请登录工作台。', 401, 'OPERATOR_REQUIRED');
      assertPending(record);
      record.project = { id:project.id, name:project.name, runnerId:project.runnerId };
      record.access=access;
      record.permissions=Object.hasOwn(body,'automation') ? {browserAutomation:body.automation,fileOperations:body.automation} : {browserAutomation:body.browserAutomation===true,fileOperations:body.fileOperations===true};
      record.state = 'approved';
      return publicState(record);
    },
    deny(id, body) {
      if (Object.keys(body).length) throw new AppError('取消配对不接收其他参数。');
      const record = lookup(id);
      assertPending(record);
      record.state = 'denied';
      return publicState(record);
    },
    async exchange(body, caller) {
      const record = authorize(body,caller);
      if (stateOf(record) !== 'approved') throw invalidState();
      // Reserve synchronously, before any Nexus call can yield to another request.
      // Even an ambiguous upstream result must never mint a second credential.
      record.state = 'consumed';
      const approved = record.project;
      const access=record.access;
      delete record.project;
      const project = await projectFor(approved.id);
      if (project.runnerId !== approved.runnerId || project.name !== approved.name) {
        throw new AppError('项目已变更，请重新配对。', 409, 'PAIR_PROJECT_CHANGED');
      }
      if (record.expiresAt <= now()) throw invalidState();
      const expiresAt = now() + tokenLifetime;
      const scopes = ['read'];
      const failure = () => new AppError('Nexus 未确认令牌签发。请从 Navi Link 重新配对。', 502, 'PAIR_TOKEN_FAILED');
      let result;
      try {
        result = await nexus.manage('/api/tokens', { method:'POST', body:{ name:'Navi Link pairing',type:'mcp',scopes,expiresAt } });
      } catch { throw failure(); }
      if (typeof result?.token !== 'string' || !/^lb_[a-f0-9]{64}$/.test(result.token) ||
        typeof result.id !== 'string' || !/^tok_[A-Za-z0-9_-]{1,120}$/.test(result.id) || result.expiresAt !== expiresAt) {
        throw failure();
      }
      const bridge=issueBridge?.(project,caller,access,record.permissions);
      return { token:result.token, tokenId:result.id, expiresAt, endpoint:EXTENSION_MCP, scopes,
        project:{ id:project.id,name:project.name,path:null,accessMode:project.accessMode,executionMode:project.executionMode },
        ...(bridge ? {bridge} : {}) };
    }
  };
}
