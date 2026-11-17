export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const own = (object, key) => Object.hasOwn(object, key);
export const signalWith = (signal, ms) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

export async function readText(body, limit = 2_000_000) {
  if (!body) return '';
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new AppError('请求或响应超过大小限制。', 413, 'SIZE_LIMIT');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function parseBody(req, limit = 80_000) {
  if (String(req.headers['content-type']).split(';')[0].trim() !== 'application/json') {
    throw new AppError('此接口只接收 JSON。', 415);
  }
  if (Number(req.headers['content-length']) > limit) throw new AppError('请求超过大小限制。', 413);
  let value;
  try { value = JSON.parse(await readText(req, limit)); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('JSON 格式无效。'); }
  if (!isObject(value)) throw new AppError('请求必须是 JSON 对象。');
  return value;
}

export async function wireFetch(url, opts) {
  return fetch(url, { ...opts, redirect: 'error', cache: 'no-store' });
}

export async function jsonWire(response, limit) {
  return parseWireJson(await readText(response.body, limit));
}

export function parseWireJson(text) {
  try { return JSON.parse(text); }
  catch { throw new AppError('上游服务返回了无效的 JSON。', 502, 'UPSTREAM_PROTOCOL'); }
}

export function cleanMessage(value, secrets = []) {
  let text = typeof value === 'string' ? value : '';
  for (const s of secrets) if (typeof s === 'string' && s) text = text.replaceAll(s, '[已隐藏]');
  return text.slice(0, 1_500);
}

export function cleanCode(value, secrets, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    && !secrets.some(s => typeof s === 'string' && s && value.includes(s)) ? value : fallback;
}

export function textOutput(result) {
  if (!isObject(result)) return null;
  if (isObject(result.structuredContent)) return result.structuredContent;
  for (const value of result.content ?? []) {
    if (value.type === 'text') {
      try { return JSON.parse(value.text); } catch { return value.text; }
    }
  }
  return null;
}
