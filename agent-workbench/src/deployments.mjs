import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { AppError } from './net.mjs';
import { privateDir, privateWrite } from '../scripts/lib.mjs';

const actions = new Set(['inspect', 'update', 'restart']);
const pending = job => ['running', 'unknown'].includes(job.status);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const messages = {
  40: '服务器需要可用的 Docker 和 Docker Compose v2，SSH 用户须有 Docker 权限。',
  41: 'Compose 配置检查失败，请在服务器核对文件及环境变量。',
  42: '拉取镜像失败，尚未执行容器更新。请检查镜像版本、仓库登录及网络。',
  43: '容器更新或就绪检查失败，服务可能已部分更新，请检查容器状态。',
  44: '容器重启失败，请检查容器状态。',
  45: '读取容器状态失败。',
  73: '服务器上已有 Navi 部署操作在执行，请稍后检查状态。',
  255: 'SSH 连接失败或中断。请检查 SSH 别名、密钥、已确认的主机指纹和网络。'
};

export function deploymentConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('部署配置无效。');
  const string = (key, max) => {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new AppError('部署字段过长或包含控制字符。');
    return value;
  };
  const name = string('name', 80), sshHost = string('sshHost', 128), directory = string('directory', 1024);
  const project = string('project', 100), composeFile = string('composeFile', 256), panelUrl = string('panelUrl', 2048);
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sshHost)) throw new AppError('请填写应用名称和 SSH 主机别名（不含用户名、空格或选项）。');
  if (!directory.startsWith('/') || directory === '/' || posix.normalize(directory) !== directory || directory.endsWith('/')) throw new AppError('请填写服务器上已存在的应用绝对目录，不含 .. 或末尾斜杠。');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new AppError('Compose 项目名只能包含小写字母、数字、短横线和下划线。');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ya?ml$/.test(composeFile) || composeFile.split('/').some(part => !part || part === '..' || part === '.')) throw new AppError('请填写应用目录内的 Compose YAML 相对路径。');
  if (panelUrl) {
    let url;
    try { url = new URL(panelUrl); } catch { throw new AppError('管理面板地址无效。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AppError('面板地址仅支持 HTTP(S)，请勿附带账号、密码、查询参数或令牌。');
  }
  return { name, sshHost, directory, project, composeFile, panelUrl };
}

// All remote values are shell quoted. The browser cannot supply commands or SSH options.
export function deploymentCommand(config, action) {
  const c = deploymentConfig(config);
  if (!actions.has(action)) throw new AppError('不支持的部署操作。');
  const command = `umask 077; cd ${quote(c.directory)} && exec flock -n -E 73 ${quote('.navi-deploy-' + c.project + '.lock')} sh -s`;
  const lines = [
    'set -eu', 'umask 077',
    `compose() { docker compose --project-directory ${quote(c.directory)} -p ${quote(c.project)} -f ${quote(c.composeFile)} "$@"; }`,
    'docker compose version >/dev/null 2>&1 || exit 40',
    'compose config --quiet >/dev/null 2>&1 || exit 41',
    "printf 'NAVI:checked\\n'"
  ];
  if (action === 'update') lines.push(
    'compose pull --policy always --quiet >/dev/null 2>&1 || exit 42', "printf 'NAVI:pulled\\n'",
    'compose up -d --no-build --pull never --wait --wait-timeout 120 >/dev/null 2>&1 || exit 43', "printf 'NAVI:updated\\n'"
  );
  if (action === 'restart') lines.push('compose restart --timeout 30 >/dev/null 2>&1 || exit 44', "printf 'NAVI:restarted\\n'");
  lines.push("printf 'NAVI:containers\\n'", 'compose ps --all --format json 2>/dev/null || exit 45');
  return { command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', c.sshHost, command], input: lines.join('\n') + '\n' };
}

export function parseContainers(output) {
  const text = output.split('NAVI:containers\n')[1]?.trim();
  if (text === undefined) throw new Error('Missing container response');
  const rows = !text ? [] : text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('Invalid container response');
  const short = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) : '';
  return rows.map(row => ({ service: short(row.Service), name: short(row.Name), image: short(row.Image), state: short(row.State), health: short(row.Health) }));
}

export function executeDeployment(config, action, { onStage = () => {}, signal, timeout = 600_000 } = {}) {
  const spec = deploymentCommand(config, action);
  return new Promise(resolve => {
    let output = '', size = 0, buffer = '', ended = false, timer;
    const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = result => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => { child.kill('SIGKILL'); finish({ code: null, uncertain: true }); };
    timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish({ code: null, uncertain: false, unavailable: true }));
    child.stdin.on('error', () => {});
    // Do not retain stderr, environment variables, Docker config or application logs.
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 512_000) return abort();
      output += chunk; buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (/^NAVI:(checked|pulled|updated|restarted|containers)$/.test(line)) onStage(line.slice(5));
      }
    });
    child.on('close', code => finish({ code, output, uncertain: code === null || code === 255 || code === 73 }));
    child.stdin.end(spec.input);
    if (signal?.aborted) abort();
  });
}

export class DeploymentManager {
  constructor({ file = null, enabled = true, execute = executeDeployment } = {}) {
    this.file = file; this.enabled = enabled; this.execute = execute;
    this.state = { config: null, revision: '', jobs: [] };
    this.queue = Promise.resolve(); this.loaded = false; this.controller = null;
  }
  serial(fn) {
    const result = this.queue.then(async () => { await this.load(); return fn(); });
    this.queue = result.catch(() => {}); return result;
  }
  async load() {
    if (this.loaded) return;
    if (this.file) {
      try {
        const data = JSON.parse(await readFile(this.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > 20) throw new Error('Invalid deployment state');
        this.state = { config: data.config ? deploymentConfig(data.config) : null, revision: data.revision, jobs: data.jobs };
        for (const job of this.state.jobs) if (job.status === 'running') {
          job.status = job.action === 'inspect' ? 'failed' : 'unknown'; job.message = '工作台已重启，执行结果未知。请检查服务器状态后再操作。';
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw new AppError('部署记录无法读取，请检查本机私有配置文件。', 503);
      }
    }
    if (this.file) {
      let raw;
      try { raw = await readFile(join(dirname(this.file), 'deployment-target.json'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw new AppError('本机部署目标文件无法读取。', 503); }
      if (raw !== undefined) {
        let target;
        try { target = deploymentConfig(JSON.parse(raw)); }
        catch { throw new AppError('本机部署目标文件格式无效，请核对配置。', 503); }
        if (JSON.stringify(target) !== JSON.stringify(this.state.config)) {
          if (this.state.jobs.some(pending)) throw new AppError('上次部署结果尚未确认。请暂时移开新的目标文件，检查原目标状态后再更换。', 409);
          await this.replaceConfig(target);
        }
      }
    }
    this.loaded = true;
  }
  async persist() {
    if (!this.file) return;
    await privateDir(dirname(this.file));
    await privateWrite(this.file, JSON.stringify({ version: 1, ...this.state }, null, 2));
  }
  snapshot() { return structuredClone({ enabled: this.enabled, ...this.state }); }
  read() { return this.serial(() => this.snapshot()); }
  async replaceConfig(config) {
    const previous = this.state;
    this.state = { ...previous, config, revision: randomUUID() };
    try { await this.persist(); } catch { this.state = previous; throw new AppError('部署配置保存失败。', 503); }
  }
  save(input, revision) {
    return this.serial(async () => {
      if (revision !== this.state.revision) throw new AppError('部署配置已变化，请刷新后重试。', 409);
      if (this.state.jobs.some(pending)) throw new AppError('有运行中或结果未知的操作，请先检查状态。', 409);
      await this.replaceConfig(deploymentConfig(input));
      return this.snapshot();
    });
  }
  start({ action, revision, requestId }) {
    return this.serial(async () => {
      if (!this.enabled) throw new AppError('完整模拟模式不执行服务器操作。请启动本机工作台。', 409);
      if (!actions.has(action) || typeof requestId !== 'string' || !uuid.test(requestId)) throw new AppError('部署操作或请求编号无效。');
      const prior = this.state.jobs.find(job => job.id === requestId);
      if (prior) {
        if (prior.action !== action || prior.revision !== revision) throw new AppError('请求编号已用于其他操作。', 409);
        return structuredClone(prior);
      }
      if (!this.state.config || revision !== this.state.revision) throw new AppError('部署目标未配置或已更换，请确认本机配置并刷新后再操作。', 409);
      if (this.state.jobs.some(job => job.status === 'running' || (action !== 'inspect' && job.status === 'unknown'))) throw new AppError('已有运行中或结果未知的操作，请稍后检查状态。', 409);
      const latest = this.state.jobs.find(job => job.revision === revision);
      if (action !== 'inspect' && !(latest?.status === 'completed' && latest.containers.length)) {
        throw new AppError('请先检查状态，确认当前 Compose 项目存在容器。', 409);
      }
      const job = { id: requestId, action, revision, target: this.state.config.name, status: 'running', stage: 'connecting', startedAt: Date.now(), message: '', containers: [] };
      const previous = this.state.jobs;
      this.state.jobs = [job, ...previous];
      // Never let repeated failed inspections evict an unresolved mutation receipt.
      while (this.state.jobs.length > 20) {
        const index = this.state.jobs.findLastIndex(item => !pending(item));
        if (index < 0) { this.state.jobs = previous; throw new AppError('未确认操作过多，请核对服务器记录。', 409); }
        this.state.jobs.splice(index, 1);
      }
      try { await this.persist(); } catch { this.state.jobs = previous; throw new AppError('无法保存操作记录，未执行服务器操作。', 503); }
      this.controller = new AbortController();
      void this.perform(job, structuredClone(this.state.config), this.controller.signal);
      return structuredClone(job);
    });
  }
  async perform(job, config, signal) {
    let result;
    try { result = await this.execute(config, job.action, { signal, onStage: stage => { job.stage = stage; } }); }
    catch { result = { code: null, uncertain: true }; }
    await this.serial(async () => {
      job.finishedAt = Date.now();
      job.status = result.uncertain && job.action !== 'inspect' ? 'unknown' : result.code === 0 ? 'completed' : 'failed';
      job.message = result.code === 0 ? '命令已完成，请核对下方容器状态。' : result.unavailable ? '本机 SSH 无法启动，请检查系统 OpenSSH。' :
        messages[result.code] || (result.uncertain ? '连接中断或等待超时，远端操作可能仍在执行。请检查状态，勿重复更新。' : '服务器命令失败，请核对目录权限、Linux flock 和 Compose 配置。');
      if (result.code === 0) {
        try { job.containers = parseContainers(result.output); }
        catch { job.status = job.action === 'inspect' ? 'failed' : 'unknown'; job.message = '命令已返回，但容器状态无法解析，请检查服务器状态。'; }
      }
      // A successful inspect acquired the same remote lock: no earlier Navi command is still holding it.
      if (job.action === 'inspect' && job.status === 'completed') for (const earlier of this.state.jobs) if (earlier !== job && earlier.status === 'unknown') {
        earlier.status = 'unverified'; earlier.message = '已重新取得服务器锁并读取状态；此前操作结果仍无法确认。';
      }
      try { await this.persist(); }
      catch { job.status = job.action === 'inspect' ? 'failed' : 'unknown'; job.message = '操作记录保存失败，重启后请先检查服务器状态。'; }
      this.controller = null;
    });
  }
  stop() { this.controller?.abort(); }
}
