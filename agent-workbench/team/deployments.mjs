import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { privateWrite } from '../scripts/lib.mjs';
import { AppError } from '../src/net.mjs';

const requestId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stages = new Set(['pulling', 'updating', 'completed', 'source_failed', 'failed', 'unknown']);
const active = new Set(['queued', 'pulling', 'updating']);

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

async function readRequest(file) {
  let request;
  try { request = await open(file, 'r'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  try {
    const id = await request.readFile('utf8');
    if (!requestId.test(id) || id.length !== 36) throw new Error('Invalid receipt');
    return { id, startedAt: (await request.stat()).mtimeMs };
  } finally { await request.close(); }
}

export class TeamDeployments {
  constructor(directory) {
    this.request = directory ? join(directory, 'requests', 'current') : null;
    this.result = directory ? join(directory, 'status', 'result') : null;
    this.heartbeat = directory ? join(directory, 'status', 'worker') : null;
    this.queue = Promise.resolve();
  }

  async read() {
    if (!this.request) return { enabled: false, job: null };
    try {
      const seen = await stat(this.heartbeat).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      const enabled = Boolean(seen && Date.now() - seen.mtimeMs < 30_000);
      const request = await readRequest(this.request);
      if (!request) return { enabled, job: null };
      const [finishedId, stage] = (await readOptional(this.result)).trimEnd().split(' ');
      const status = finishedId === request.id && stages.has(stage) ? stage : 'queued';
      return { enabled, job: { ...request, status } };
    } catch {
      throw new AppError('部署状态暂时无法读取。', 503);
    }
  }

  start({ id, previousId }) {
    const operation = this.queue.then(async () => {
      if (typeof id !== 'string' || id.length !== 36 || !requestId.test(id) ||
          !(previousId === null || (typeof previousId === 'string' && previousId.length === 36 && requestId.test(previousId))) || id === previousId) {
        throw new AppError('部署请求无效。');
      }
      const { enabled, job } = await this.read();
      if (job?.id === id) return { id, created: false };
      if (!enabled) throw new AppError('部署服务当前不可用。', 503);
      if (previousId !== (job?.id ?? null) || active.has(job?.status)) {
        throw new AppError('部署状态已变化，请查看当前记录。', 409);
      }
      try { await privateWrite(this.request, id); }
      catch { throw new AppError('无法提交部署请求，请稍后重试。', 503); }
      return { id, created: true };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
