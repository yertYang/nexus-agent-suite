import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './net.mjs';

const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const definitions = [
  ['localbridge_project_info', '查看项目权限', schema({ projectId: string }, ['projectId'])],
  ['localbridge_directory_list', '列出目录', schema({ projectId: string, path: string }, ['projectId'])],
  ['localbridge_file_read', '读取 UTF-8 文件', schema({ projectId: string, path: string }, ['projectId', 'path'])],
  ['localbridge_file_create', '创建文件，需审批', schema({ projectId: string, path: string, content: string }, ['projectId', 'path', 'content'])]
].map(([name, description, inputSchema]) => [name, { name, description, inputSchema }]);
const success = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

export class DemoNexus {
  base = 'http://127.0.0.1:18080';
  rows = [{ id: 'demo-sandbox', name: 'Navi 示例项目', runnerId: 'demo-runner', enabled: true, accessMode: 'read-write', executionMode: 'disabled' }];
  data = new Map([['demo-sandbox', new Map([
    ['README.md', '# Navi 示例项目\n\n这是内存模拟目录，可以体验目录读取、工具轨迹和写入审批。\n模拟操作不会修改电脑上的任何文件。']
  ])]]);
  async projects() { return this.rows.map(p => ({ ...p })); }
  async listTools() { return new Map(definitions); }
  async runners() { return [{ id: 'demo-runner', name: '模拟 Runner' }]; }
  async approvals() { return []; }
  async manage(route, { body = {} } = {}) {
    if (route === '/api/management/projects/authorize') {
      const row = { id: 'demo-' + randomUUID().slice(0, 8), name: body.name || '新模拟项目',
        runnerId: 'demo-runner', accessMode: 'read-only', executionMode: 'disabled', enabled: true };
      this.rows.push(row);
      this.data.set(row.id, new Map([['README.md', '# 模拟项目\n内存示例']]));
      return row;
    }
    const match = route.match(/^\/api\/management\/projects\/([^/]+)\/(access|execution)$/);
    if (match) {
      const row = this.rows.find(p => p.id === decodeURIComponent(match[1]));
      if (row) return Object.assign(row, body);
    }
    throw new AppError('演示模式不会创建真实令牌或变更本地授权。', 409);
  }
  async call(name, args, { signal } = {}) {
    await delay(220, undefined, { signal });
    const files = this.data.get(args.projectId);
    if (name === 'localbridge_project_list') return success({ projects: this.rows, safetyLayerDisabled: false });
    if (name === 'localbridge_session_list') {
      const sessions = [
        { sessionId: 'demo-session-1', title: '阅读项目概况', state: 'completed', goal: '核对示例目录与工作流' },
        { sessionId: 'demo-session-2', title: '验证工具链路', state: 'active', goal: '跟踪一次工具调用' },
        { sessionId: 'demo-session-3', title: '整理项目说明', state: 'completed', goal: '查看项目文档' }
      ];
      const offset = Number(args.cursor ?? 0), limit = args.limit ?? 2;
      return success({ sessions: sessions.slice(offset, offset + limit), hasMore: offset + limit < sessions.length,
        nextCursor: offset + limit < sessions.length ? String(offset + limit) : undefined });
    }
    if (name === 'localbridge_session_events') return success({ events: [{ type: 'session.started', message: '模拟会话事件' }], hasMore: false });
    if (!files) return { ...success({ code: 'PROJECT_NOT_FOUND' }), isError: true };
    if (name === 'localbridge_project_info') return success(this.rows.find(p => p.id === args.projectId));
    if (name === 'localbridge_directory_list') return success({ entries: [...files.keys()].map(name => ({ name, type: 'file' })) });
    if (name === 'localbridge_file_read') {
      if (!files.has(args.path)) return { ...success({ code: 'FILE_NOT_FOUND', path: args.path }), isError: true };
      return success({ path: args.path, lines: files.get(args.path).split('\n').map((text, i) => ({ line: i + 1, text })) });
    }
    if (name === 'localbridge_file_create') {
      if (files.has(args.path)) return { ...success({ code: 'FILE_ALREADY_EXISTS', path: args.path }), isError: true };
      files.set(args.path, args.content);
      return success({ path: args.path, created: true });
    }
    return { ...success({ code: 'MOCK_TOOL_NOT_IMPLEMENTED' }), isError: true };
  }
}

function message(text) {
  return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
}
function call(name, args) {
  return { status: 'completed', output: [{ type: 'function_call', name, call_id: 'call_' + randomUUID(), arguments: JSON.stringify(args) }] };
}

export class DemoModel {
  async models() { return [{ id: 'nexus-demo', label: 'Navi 演示 · 模拟响应' }]; }
  async respond({ input, signal }) {
    await delay(400, undefined, { signal });
    const turnStart = input.findLastIndex(i => i.role === 'user');
    const projectId = input[turnStart].content.match(/项目 ID：(.+?)。/)?.[1];
    const prompt = input[turnStart].content.split('\n\n').slice(1).join('\n\n');
    const browse = /浏览器|网页测试|表单测试|browser test/i.test(prompt);
    const actualPrompt=prompt.split('用户用例描述：').at(-1);
    const latestCall = input.slice(turnStart).findLast(i => i.type === 'function_call');
    const latestResult = input.slice(turnStart).findLast(i => i.type === 'function_call_output');
    if (!latestCall || !latestResult) {
      if (browse) {
        const target = actualPrompt.match(/https?:\/\/[^\s，。；、））"']+/i)?.[0];
        const expect = /失败|故意|fail/i.test(actualPrompt) ? 'Hello Wrong' : 'Hello Ada';
        const name = expect.endsWith('Wrong') ? '核对错误断言' : '表单填写与断言';
        const content = JSON.stringify({name,steps:[
          {action:'goto',path:target||'/'}, {action:'fill',selector:'[data-testid=name]',value:'Ada'},
          {action:'click',selector:'[data-testid=submit]'}, {action:'expectText',selector:'[data-testid=result]',text:expect},
          {action:'screenshot'}
        ]},null,2);
        return call('localbridge_file_create',{projectId,path:'case-'+randomUUID().slice(0,8)+'.json',content});
      }
      if (/创建|写入|create|write/i.test(prompt)) {
        const path = prompt.match(/\b([A-Za-z0-9_-]+\.txt|package\.json)\b/)?.[1] ?? ('nexus-demo-' + randomUUID().slice(0, 8) + '.txt');
        return call('localbridge_file_create', { projectId, path, content: path === 'package.json' ? '{"private":true}\n' : 'Navi · 模拟模型验证\n' });
      }
      if (/列出|目录|list/i.test(prompt)) return call('localbridge_directory_list', { projectId, path: '.' });
      return call('localbridge_file_read', { projectId, path: 'README.md' });
    }
    const result = JSON.parse(latestResult.output);
    const structured = result.structuredContent ?? {};
    if (browse && latestCall.name === 'localbridge_command_run' && structured.browserReport) {
      const value=structured.browserReport;
      const failure=value.steps.find(step=>step.status==='failed');
      return message('实际浏览器报告：' + (value.status==='passed' ? '通过' : '失败') + '。'
        + '\n地址：' + (value.url || '未能导航')
        + '\n已记录 ' + value.steps.length + ' 个步骤；' + (failure?.error ? '失败原因：'+failure.error : '点击和页面断言已返回。')
        + (structured.screenshotArtifactId ? '\n可在工具轨迹查看截图。' : '')
        + '\n\n以上是模拟模型对真实工具报告的总结。');
    }
    if (result.isError) return message('模拟模型收到工具拒绝或错误：' + (structured.code || result.content?.[0]?.text || '未知错误') + '。本轮未确认该操作成功。');
    if (latestCall.name === 'localbridge_file_create') {
      if (browse) {
        const target = actualPrompt.match(/https?:\/\/[^\s，。；、））"']+/i)?.[0];
        return call('localbridge_command_run',{projectId,kind:'node-script',path:'browser-test.mjs',
          args:['--case',JSON.parse(latestCall.arguments).path,'--report-mode','runner',...(target?['--url',target]:[])],cwd:'.',timeoutMs:30_000});
      }
      return call('localbridge_file_read', { projectId, path: JSON.parse(latestCall.arguments).path });
    }
    if (latestCall.name === 'localbridge_directory_list') {
      const names = (structured.entries ?? []).map(x => x.name ?? x.path).filter(Boolean);
      return message('目录读取已返回。' + (names.length ? '\n\n' + names.map(name => '· ' + name).join('\n') : '') + '\n\n这是模拟模型生成的总结。');
    }
    const text = (structured.lines ?? []).slice(0, 24).map(l => l.text).join('\n');
    return message('已读取 ' + JSON.parse(latestCall.arguments).path + '。\n\n' + text + '\n\n这是模拟模型生成的总结。');
  }
}
