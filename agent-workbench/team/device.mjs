import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Nexus, approvalRequired } from '../src/nexus.mjs';
import { textOutput } from '../src/net.mjs';
import { RUNTIME } from '../scripts/lib.mjs';
import { teamOrigin } from './site.mjs';
import { taskInput } from './tasks.mjs';
import { hiddenInput } from './cli-input.mjs';
const safeText = (s) => String(s).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '�');
export async function runDeviceTask({ nexus, project, task, canCreate, approve, recheck }) {
  let t;
  try {
    t = taskInput(task, canCreate);
  } catch {
    return { status: 'denied', result: '任务超出设备授权。' };
  }
  const permitted = async () => {
    const p = (await nexus.projects()).find(
      (x) => x.enabled && x.id === project.id && x.runnerId === project.runnerId
    );
    return p && (t.action !== 'create' || p.accessMode === 'read-write');
  };
  if (!(await permitted())) return { status: 'denied', result: '本机项目权限已变化。' };
  if (!(await approve(t))) return { status: 'denied', result: '用户在本机拒绝。' };
  if (!(await permitted()) || !(await recheck()))
    return { status: 'denied', result: '设备、任务或目录授权已失效。' };
  const tools = {
    list: 'localbridge_directory_list',
    read: 'localbridge_file_read',
    create: 'localbridge_file_create'
  };
  const args = {
    projectId: project.id,
    path: t.path,
    ...(t.action === 'create'
      ? { content: t.content }
      : t.action === 'read'
        ? { startLine: 1, maxLines: 120 }
        : {})
  };
  let reply;
  try {
    reply = await nexus.call(tools[t.action], args);
  } catch {
    return { status: t.action === 'create' ? 'unknown' : 'failed', result: 'Runner 未确认结果。' };
  }
  if (reply.isError)
    return {
      status: 'failed',
      result: approvalRequired(reply) ? 'Nexus 要求额外审批，此设备连接未执行写入。' : 'Runner 未完成此操作。'
    };
  const row = textOutput(reply);
  let result;
  if (t.action === 'read' && Array.isArray(row?.lines)) result = row.lines.map((x) => x.text).join('\n');
  else if (t.action === 'list' && Array.isArray(row?.entries))
    result =
      row.entries
        .filter((x) => typeof x.name === 'string' && x.accessible !== false)
        .map((x) => x.name)
        .join('\n') || '（空目录）';
  else if (t.action === 'create' && row?.path === t.path) result = '已创建：' + t.path;
  else return { status: t.action === 'create' ? 'unknown' : 'failed', result: 'Runner 返回值无法核对。' };
  return {
    status: 'completed',
    result: result.length > 14000 ? result.slice(0, 14000) + '\n（已截断）' : result
  };
}
async function main() {
  const [originArg, projectId, ...flags] = process.argv.slice(2);
  if (!originArg || !process.stdin.isTTY)
    throw Error(
      '用法：npm run team:device -- https://团队网站 [本机项目ID] [--allow-create]，在交互终端运行。'
    );
  const origin = teamOrigin(originArg),
    keyFile = resolve(RUNTIME, 'private/nexus-workbench-mcp.key');
  let token;
  try {
    token = (await readFile(keyFile, 'utf8')).trim();
  } catch {
    throw Error('请先启动本机 Navi 工作台并登记目录。');
  }
  const nexus = new Nexus({ url: 'http://127.0.0.1:18080/mcp', token }),
    projects = (await nexus.projects()).filter((x) => x.enabled);
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    console.log('请使用以下本机项目 ID 重新运行：');
    for (const p of projects) console.log(safeText(p.name) + ' · ' + safeText(p.id));
    if (!projects.length) console.log('请在本机 Navi「项目与权限」添加目录。');
    return;
  }
  const canCreate = flags.includes('--allow-create');
  if (flags.some((x) => x !== '--allow-create') || (canCreate && project.accessMode !== 'read-write'))
    throw Error('创建文件需要本机项目读写权限和 --allow-create。');
  let bearer;
  async function post(route, body) {
    const r = await fetch(origin + '/api/client/' + route, {
      redirect: 'error',
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: 'Bearer ' + bearer } : {})
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw Error('团队服务拒绝请求或连接过期（HTTP ' + r.status + '）。');
    return r.json();
  }
  console.log(
    '绑定到 ' +
      origin +
      '；仅授权 ' +
      safeText(project.name) +
      '（' +
      (canCreate ? '读取及新建文件' : '只读') +
      '）。'
  );
  const code = await hiddenInput('输入网站生成的设备配对码（不回显）：');
  const grant = await post('redeem', {
    code,
    kind: 'device',
    label: hostname(),
    project: project.name,
    canCreate
  });
  bearer = grant.token;
  console.log('已绑定 ' + safeText(grant.username) + '。保持终端打开；Ctrl+C 退出。');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
    rl.close();
  };
  process.once('SIGINT', stop);
  rl.once('SIGINT', stop);
  rl.once('close', () => shutdown.abort());
  try {
    while (!shutdown.signal.aborted) {
      const { task } = await post('device/claim', {});
      if (task) {
        const outcome = await runDeviceTask({
          nexus,
          project,
          task,
          canCreate,
          approve: async (t) => {
            console.log(
              '账号 ' +
                safeText(grant.username) +
                ' 请求 ' +
                t.action +
                '：' +
                safeText(project.name) +
                ' / ' +
                safeText(t.path)
            );
            if (t.action === 'create') console.log('写入内容：\n' + safeText(t.content));
            else console.log('此操作的结果将返回你的团队网站。');
            return (
              (await rl.question('输入 yes 批准，其他输入拒绝：', { signal: shutdown.signal })).trim() ===
              'yes'
            );
          },
          recheck: async () => {
            await post('device/check', { id: task.id });
            return true;
          }
        });
        await post('device/result', { id: task.id, ...outcome });
      }
      await delay(2000, undefined, { signal: shutdown.signal });
    }
  } finally {
    rl.close();
    process.removeListener('SIGINT', stop);
    await post('device/disconnect', {}).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((e) => {
    if (e.name !== 'AbortError') {
      console.error(e.message);
      process.exitCode = 1;
    }
  });
