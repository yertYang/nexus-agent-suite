const $ = id => document.getElementById(id);
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
const main = $('main');
const narrowSidebar = window.matchMedia('(max-width: 640px)');
const desktopSidebarPreference = 'navi.sidebar.collapsed';
const navNames = { chat:'对话工作区',web:'浏览器任务',projects:'项目与权限', approvals:'审批中心', sessions:'项目会话', settings:'连接设置', deployments:'部署管理', extension:'网页扩展' };
const runStatus = { queued:'排队中', running:'运行中', awaiting_approval:'等待审批', completed:'已完成',
  failed:'已失败', cancelled:'已取消', limit_reached:'达到上限' };
const terminal = new Set(['completed','failed','cancelled','limit_reached']);
const modelLabel = model => model.id === 'nexus-demo' ? 'Navi 演示 · 模拟响应' : model.label;
const projectLabel = name => name === '栖舟示例项目' ? 'Navi 示例项目' : name === '栖舟浏览器用例' ? 'Navi 浏览器任务' : name;
const modeName = { demo: '完整模拟', 'model-demo': '模拟模型 · 真实 Nexus', local: 'API 模式' };
const connectionDraft = () => ({ baseUrl:null, clientKey:'', pending:false, message:'', error:false });
const s = { csrf:'', page:'chat', status:null, models:[], projects:[], runs:[], projectId:'', model:'',
  active:null, events:[], cursor:0, loadId:0, generation:0, approvals:[], pages:null, draft:'', webDraft:{url:'',prompt:'',example:false}, connection:connectionDraft(), pairIntent:null, submitting:false, stopping:false, maxRounds:12 };
let toastTimer;
const mk = (tag, cls, text) => {
  const node = document.createElement(tag); if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; return node;
};
const control = (tag, text, variant, size) => {
  const result = mk(tag,'nv-button',text); result.dataset.variant=variant; result.dataset.size=size; return result;
};
const uiButton = (text, variant = 'secondary', size = 'md') => {
  const result = control('button',text,variant,size); result.type='button'; return result;
};
const viewButton = (text, action, variant, size) => {
  const result = uiButton(text,variant,size); result.addEventListener('click',action); return result;
};
const actionLink = (text, href) => {
  const result=control('a',text,'secondary','sm'); result.href=href; return result;
};
const section = title => { const panel = mk('section', 'nv-card'); panel.append(mk('h2', '', title)); return panel; };
const pre = value => mk('pre', 'codebox', JSON.stringify(value, null, 2));
const badge = (text, tone = 'neutral') => {
  const span = mk('span','nv-status',text); span.dataset.tone=tone; return span;
};
const labelFor = (name, value) => ({ 'read-only':'只读', 'read-write':'读写', disabled:'关闭命令', 'safe-only':'安全命令', 'project-code':'项目命令',
  pending:'待审批', approved:'已批准', denied:'已拒绝', expired:'已过期', consumed:'已执行',
  active:'进行中', completed:'已完成', abandoned:'已放弃' })[value] ?? value ?? name;
function toast(text, bad = false) {
  const el = $('toast'); el.textContent = text; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4400);
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = s.csrf;
    headers['X-Workbench-Client'] = 'operator-ui';
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { method, headers, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error?.code === 'OPERATOR_REQUIRED') lock();
  if (!res.ok) { const error = new Error(data.error?.message || ('请求失败 · HTTP ' + res.status)); error.status = res.status; throw error; }
  return data;
}
function lock() {
  setMobileSidebar(false); s.csrf = ''; s.loadId++; s.generation++;
  s.connection.clientKey = ''; s.connection = connectionDraft(); s.deploymentRequest = null;
  const key = $('model-api-key'); if (key) key.value = '';
  $('workspace').hidden = true; $('login').hidden = false;
}
function announce(error) { toast(error?.message || String(error), true); }
function action(button, fn) { return async () => { button.disabled = true; try { await fn(); } catch (e) { announce(e); } finally { button.disabled = false; } }; }
function pageIntro(title, description) {
  const intro = mk('header','page-intro');
  intro.append(mk('h1','',title),mk('p','',description));
  return intro;
}
function field(label, node, hint) {
  const wrap = mk('div','nv-field'); const title = mk('label','nv-label',label);
  if (node.localName==='input') node.classList.add('nv-input');
  if (node.localName==='textarea') node.classList.add('nv-textarea');
  if (!node.id) node.id = 'field-' + (++s.generation);
  title.htmlFor = node.id; wrap.append(title, node); if (hint) wrap.append(mk('small', '', hint)); return wrap;
}
function selection(options, selected, placeholder) {
  const el = mk('select','nv-select');
  if ('HTMLSelectedContentElement' in window) {
    const display = mk('button'); display.type = 'button';
    display.append(mk('selectedcontent')); el.append(display);
  }
  if (placeholder) {
    const e = new Option(placeholder, '', false, !selected); e.disabled = true; el.add(e);
  }
  for (const [value, title] of options) el.add(new Option(title, value, false, value === selected));
  if (!options.length) el.disabled = true;
  return el;
}
function submitButton(form, text, handler) {
  const button = uiButton(text,'primary'); button.type = 'submit';
  const block = mk('div','nv-row actions'); block.append(button); form.append(block);
  form.addEventListener('submit', e => { e.preventDefault(); void action(button, handler)(); }); return button;
}
function activeStatus(run) { return run && !terminal.has(run.status); }
function chooseRunContext(run) {
  if (s.projects.some(project => project.enabled && project.id === run.projectId)) s.projectId = run.projectId;
  if (s.models.some(model => model.id === run.model)) s.model = run.model;
}
function composerBlocker() {
  if (s.status?.demoExample) return { message:'尚未配置 API。草稿已保留，请先在连接设置填写 URL 和 Key。', page:'settings' };
  if (!s.models.some(model => model.id === s.model)) return { message:'暂无可用模型。草稿已保留，请在连接设置检查 URL 和 Key。', page:'settings' };
  if (!s.projects.some(project => project.enabled && project.id === s.projectId)) return { message:'请先授权并选择一个项目。草稿已保留。', page:'projects' };
  return null;
}
function updateSend() {
  const send = $('send'), stop = $('stop');
  if (!send || !stop) return;
  const active = Boolean(activeStatus(s.active));
  send.hidden = active;
  send.disabled = active || s.submitting || !s.draft.trim();
  stop.hidden = !active;
  stop.disabled = !active || s.stopping;
}
function setMobileSidebar(open) {
  open = open && narrowSidebar.matches;
  $('workspace').classList.toggle('sidebar-open',open);
  $('sidebar-toggle').setAttribute('aria-expanded',String(open));
  $('sidebar-toggle').setAttribute('aria-label',open ? '关闭导航' : '打开导航');
  $('sidebar-scrim').hidden = !open;
}
function setDesktopSidebar(collapsed,remember=true) {
  $('workspace').classList.toggle('sidebar-collapsed',collapsed);
  const button=$('desktop-sidebar-toggle');
  const label=collapsed?'展开侧边栏':'收起侧边栏';
  button.setAttribute('aria-expanded',String(!collapsed));
  button.setAttribute('aria-label',label);
  button.title=label;
  button.querySelector('use').setAttribute('href',collapsed?'#i-sidebar-open':'#i-sidebar-close');
  if (remember) {
    try { localStorage.setItem(desktopSidebarPreference,String(collapsed)); } catch {}
  }
}
function desktopSidebarCollapsed() {
  try { return localStorage.getItem(desktopSidebarPreference)==='true'; } catch { return false; }
}
function sizePrompt() {
  const input = $('prompt');
  if (!input || CSS.supports('field-sizing','content')) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight,200) + 'px';
}
function renderRecent() {
  const box = $('recent'); box.replaceChildren();
  if (!s.runs.length) { box.append(mk('p', '', '还没有对话记录')); return; }
  for (const run of s.runs.slice(0, 10)) {
    const b = uiButton(run.prompt,'ghost','sm'); b.classList.toggle('active',run.runId===s.active?.runId);
    b.title = run.prompt; b.addEventListener('click', () => { void openRun(run.runId).catch(announce); }); box.append(b);
  }
}
async function refreshAll({ notify = false } = {}) {
  const [status, projects, models, runs, approvals] = await Promise.allSettled([
    api('/api/status'), api('/api/projects'), api('/api/models'), api('/api/runs'), api('/api/nexus/approvals')
  ]);
  if (!s.csrf) return;
  if (status.status === 'fulfilled') s.status = status.value;
  if (projects.status === 'fulfilled') s.projects = projects.value.projects;
  s.models = models.status === 'fulfilled' ? models.value.models : [];
  if (runs.status === 'fulfilled') s.runs = runs.value.runs;
  if (approvals.status === 'fulfilled') s.approvals = approvals.value.approvals;
  const pList = s.projects.filter(p => p.enabled);
  if (!pList.some(p => p.id === s.projectId)) s.projectId = pList[0]?.id ?? '';
  if (!s.models.some(m => m.id === s.model)) {
    const fallback = models.status === 'fulfilled' ? models.value.defaultModel : '';
    s.model = s.models.some(m => m.id === fallback) ? fallback : (s.models[0]?.id ?? '');
  }
  updateShell(); renderRecent();
  if (notify) toast(status.status === 'fulfilled' ? '已刷新连接状态' : '连接状态暂不可用', status.status !== 'fulfilled');
}
function updateShell() {
  const chip = $('mode-chip');
  const mode = modeName[s.status?.mode] ?? '正在检测';
  if (chip.textContent !== mode) chip.textContent = mode;
  chip.title = mode;
  chip.dataset.tone=s.status?.mode === 'local' ? 'info' : 'warning';
  for (const link of $('nav').querySelectorAll('a')) {
    link.classList.toggle('active', link.dataset.page === s.page);
    if (link.dataset.page === s.page) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  }
  const count = s.approvals.filter(a => a.status === 'pending').length;
  $('approval-count').hidden = count === 0;
  $('approval-count').textContent = String(count);
}
function clearActive() { s.loadId++; s.active = null; s.events = []; s.cursor = 0; }
function goto(name) { setMobileSidebar(false); if (location.hash.split('?')[0] !== '#' + name) location.hash = name; else render(); }
function newChat() {
  if (s.submitting || activeStatus(s.active)) { toast('当前运行仍在进行，可先停止或等待完成。', true); return; }
  clearActive(); s.draft = ''; goto('chat'); renderRecent();
}
async function openRun(id) {
  const ticket = ++s.loadId; s.cursor = 0; s.events = [];
  const run = await api('/api/runs/' + encodeURIComponent(id));
  if (ticket !== s.loadId) return;
  s.active = run; chooseRunContext(run); goto('chat'); renderRecent();
  void polling(ticket);
}
async function polling(ticket) {
  if (ticket !== s.loadId || !s.active || !s.csrf) return;
  try {
    const value = await api('/api/runs/' + encodeURIComponent(s.active.runId) + '/events?after=' + s.cursor);
    if (ticket !== s.loadId) return;
    const changed = s.active.status !== value.run.status || value.events.length;
    s.events.push(...value.events); s.cursor = value.next; s.active = value.run;
    s.runs = s.runs.map(run => run.runId === value.run.runId ? value.run : run);
    if (s.page === 'chat' && changed) paintRun();
    if (!terminal.has(s.active.status) || s.cursor < s.active.lastSeq) {
      setTimeout(() => void polling(ticket), s.cursor < s.active.lastSeq ? 20 : 415);
    }
  } catch (error) {
    if (ticket !== s.loadId) return;
    announce(error);
    if (s.csrf) setTimeout(() => void polling(ticket), 2200);
  }
}
function openComposerApproval() {
  const tray = $('tool-tray'), card = tray?.querySelector('.approval-card');
  if (!s.active?.pending || !card) return goto('approvals');
  tray.open = true;
  card.focus({preventScroll:true});
  card.scrollIntoView({block:'nearest'});
}
async function stopRun() {
  const run = s.active;
  if (!activeStatus(run) || s.stopping) return;
  s.stopping = true;
  updateSend();
  try {
    const cancelled = await api('/api/runs/' + run.runId + '/cancel',{method:'POST'});
    s.runs = s.runs.map(item => item.runId === cancelled.runId ? cancelled : item);
    if (s.active?.runId === cancelled.runId) {
      s.active = cancelled;
      if (s.page === 'chat') paintRun();
    }
    renderRecent();
  } finally { s.stopping = false; updateSend(); }
}
function chat() {
  const panel = mk('section','chat-panel');
  const top = mk('div','chat-top'), title = mk('strong','','项目任务');
  const proj = selection(s.projects.filter(p => p.enabled).map(p => [p.id,projectLabel(p.name)]),s.projectId,'选择项目');
  proj.id = 'project-select'; proj.dataset.size='sm'; proj.setAttribute('aria-label','选择项目');
  const updateTitle = (control,label) => {control.title = control.selectedOptions[0]?.textContent || label;};
  updateTitle(proj,'选择项目');
  proj.addEventListener('change', () => { s.projectId = proj.value; updateTitle(proj,'选择项目'); paintRun(); });
  top.append(title,proj); panel.append(top);

  const transcript = mk('div','transcript'); transcript.id = 'transcript'; transcript.setAttribute('aria-label','对话记录'); panel.append(transcript);
  const wrapper = mk('div','composer-wrap'), form = mk('form','composer');
  form.innerHTML = `<textarea id="prompt" placeholder="与 Navi 一起工作" aria-label="消息" aria-describedby="composer-meta" enterkeyhint="send" rows="2" maxlength="16000" required></textarea>
    <div class="composer-bottom">
      <div class="composer-left">
        <details id="composer-menu" class="composer-menu">
          <summary class="nv-icon-button composer-plus" data-variant="ghost" data-size="sm" aria-label="任务与设置" title="任务与设置">${icon('plus')}</summary>
          <div class="composer-popover">
            <a href="#projects">${icon('folder')}项目与权限</a>
            <details class="composer-advanced"><summary>${icon('sliders')}高级选项${icon('chevron')}</summary>
              <label for="rounds">最多模型轮数<input id="rounds" class="nv-input" data-size="sm" aria-label="最多模型轮数" type="number" min="1" max="12" step="1"></label>
            </details>
          </div>
        </details>
        <button id="composer-approval" class="nv-button composer-approval" data-variant="ghost" data-size="sm" type="button" title="写入和命令执行逐次确认，项目权限仍生效">${icon('hand')}<span>请求批准</span><i class="approval-dot" hidden></i></button>
      </div>
      <div class="composer-right">
        <div class="model-control"></div>
        <button id="send" class="nv-icon-button send" data-variant="primary" type="submit" aria-label="发送消息" title="发送消息">${icon('send')}</button>
        <button id="stop" class="nv-icon-button send" data-variant="primary" type="button" aria-label="停止运行" title="停止运行" hidden>${icon('stop')}</button>
      </div>
    </div>`;
  const model = selection(s.models.map(m => [m.id,modelLabel(m)]),s.model,'选择模型');
  model.id = 'model-select'; model.dataset.variant='plain'; model.dataset.size='sm'; model.setAttribute('aria-label','选择模型');
  updateTitle(model,'选择模型');
  model.addEventListener('change', () => { s.model = model.value; updateTitle(model,'选择模型'); paintRun(); });
  form.querySelector('.model-control').prepend(model);

  const menu = form.querySelector('#composer-menu');
  const rounds = form.querySelector('#rounds');
  rounds.value = String(s.maxRounds);
  function saveRounds() {
    if (Number.isInteger(rounds.valueAsNumber)) s.maxRounds = Math.min(12,Math.max(1,rounds.valueAsNumber));
    rounds.value = String(s.maxRounds);
  }
  rounds.addEventListener('input', () => {if (rounds.validity.valid && rounds.value) s.maxRounds = rounds.valueAsNumber;});
  rounds.addEventListener('change',saveRounds);
  rounds.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveRounds(); menu.open = false; menu.querySelector('summary').focus(); }
  });
  form.querySelector('#composer-approval').addEventListener('click',openComposerApproval);
  form.querySelector('#stop').addEventListener('click',() => void stopRun().catch(announce));
  const input = form.querySelector('#prompt'), send = form.querySelector('#send');
  input.value = s.draft;
  let composing = false;
  input.addEventListener('input', () => { s.draft = input.value; sizePrompt(); updateSend(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || composing || e.keyCode === 229) return;
    e.preventDefault();
    if (!e.repeat && !send.disabled) form.requestSubmit(send);
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    if (!send.disabled) { menu.open = false; void submitRun().catch(announce); }
  });
  const note = mk('div','composer-meta'); note.id = 'composer-meta'; wrapper.append(form,note); panel.append(wrapper);
  const tray = mk('details','tool-tray'); tray.id = 'tool-tray'; tray.hidden = true;
  const heading = mk('summary','tray-heading'); heading.innerHTML = icon('activity') + '<strong>工具调用</strong><span id="run-pill" class="nv-status" data-tone="neutral">待运行</span>';
  const timeline = mk('div','timeline'); timeline.id = 'timeline';
  tray.append(heading,timeline); transcript.append(tray); main.append(panel);
  sizePrompt(); paintRun();
}
async function submitRun() {
  const draft = s.draft, prompt = draft.trim(), maxRounds = s.maxRounds;
  if (!prompt || s.submitting || activeStatus(s.active)) return;
  const blocker = composerBlocker();
  if (blocker) { toast(blocker.message, true); return; }
  const previousRunId = s.active?.taskMode !== 'web' && s.active?.status === 'completed' && s.active.projectId === s.projectId && s.active.model === s.model ? s.active.runId : undefined;
  s.submitting = true;
  updateSend();
  try {
    const run = await api('/api/runs', {method:'POST',body:{projectId:s.projectId,model:s.model,prompt,maxRounds,approvalMode:'writes',previousRunId}});
    if (s.draft === draft) {
      s.draft = ''; if ($('prompt')) $('prompt').value = ''; sizePrompt();
    }
    s.runs = [run, ...s.runs]; await openRun(run.runId);
  } finally { s.submitting = false; updateSend(); }
}
function paintRun() {
  const transcript = $('transcript'), timeline = $('timeline'), tray = $('tool-tray');
  if (!transcript || !timeline) return;
  const run = s.active, active = activeStatus(run), status = run?.status;
  updateSend();
  $('project-select').disabled = active || !s.projects.some(project => project.enabled);
  $('model-select').disabled = active || !s.models.length;
  $('composer-approval').querySelector('.approval-dot').hidden = !run?.pending;
  const note = $('composer-meta');
  const blocker = composerBlocker();
  if (blocker) {
    const link = mk('a','',blocker.page === 'settings' ? '打开连接设置' : '打开项目与权限');
    link.href = '#' + blocker.page;
    const text = blocker.page === 'projects' ? '发送前请选择已授权的项目。' :
      s.status?.demoExample ? '填写 URL 和 Key 后可发送，草稿会保留。' : '暂无可用模型，请检查 URL 和 Key。';
    note.replaceChildren(text, ' ', link);
  } else {
    note.textContent = 'Enter 发送 · Shift + Enter 换行 · 写入和命令执行需审批';
  }
  const statusEl = $('run-pill');
  const hasActions = Boolean(run?.pending) || s.events.some(e => e.type.startsWith('tool.'));
  tray.hidden = !hasActions;
  const hasReport=Boolean(run) && s.events.some(e=>e.type==='browser.report' || e.type==='test.report');
  if (run?.pending || hasReport && tray.dataset.reportOpened !== run.runId) {
    tray.open = true;
    if (hasReport) tray.dataset.reportOpened = run.runId;
  }
  statusEl.textContent = runStatus[status] ?? '待运行';
  statusEl.dataset.tone = ({awaiting_approval:'warning',limit_reached:'warning',failed:'danger',completed:'success',running:'info'})[status] || 'neutral';
  const openKeys = new Set([...timeline.querySelectorAll('details[open]')].map(e => e.dataset.details));
  const follow = transcript.scrollHeight - (transcript.scrollTop + transcript.clientHeight) < 55;
  const oldScroll = transcript.scrollTop, oldTimeline = timeline.scrollTop;
  transcript.replaceChildren(); timeline.replaceChildren();
  if (!run) {
    transcript.append(mk('p','empty-chat','输入任务，开始工作。'),tray);
  } else {
    const user = mk('div','message user',run.prompt); transcript.append(user,tray);
    for (const e of s.events) {
      if (e.type === 'model.text') {
        const reply = mk('div','message assistant');
        reply.append(mk('span','message-label',s.status?.mode === 'local' ? 'Navi' : 'Navi · 模拟'),NaviReply.render(e.data.text));
        transcript.append(reply);
      }
    }
    if (run.uncertain) transcript.append(mk('div','message error','已停止后续调用。含状态未知的操作可能仍在 Runner 完成，请先核对实际结果。'));
    if (status === 'failed' && run.error) transcript.append(mk('div','message error',run.error));
    if (status === 'limit_reached') transcript.append(mk('div','message notice','本次运行达到上限，已停止后续调用。'));
    if (status === 'cancelled' && !run.uncertain) transcript.append(mk('div','message notice','运行已取消，后续工具不会发出。'));
    if (active) {
      const text = status === 'awaiting_approval' ? '等待人工确认后继续' : '正在处理 · 第 ' + Math.max(run.round,1) + ' 轮';
      transcript.append(mk('div','message notice',text));
    }
  }
  if (follow) transcript.scrollTop = transcript.scrollHeight; else transcript.scrollTop = oldScroll;
  if (run?.pending) {
    const p = run.pending;
    const card = mk('div','nv-card tool-card approval-card'); card.tabIndex = -1;
    card.append(mk('strong','',p.kind === 'nexus' ? 'Nexus 要求审批' : p.tool?.startsWith('navi_test_')?'确认测试操作':'此调用需确认'));
    card.append(mk('p','',p.summary || p.tool));
    if (p.tool?.startsWith('navi_test_') && p.args) paintTestApproval(card,p.args);
    else if (p.args) card.append(pre(p.args));
    const actions = mk('div','nv-row actions'); card.append(actions);
    if (p.kind === 'nexus') {
      actions.append(actionLink('打开 Nexus 审批','#approvals?approvalId=' + encodeURIComponent(p.approvalId)));
    } else for (const [decision,text,cls] of [['deny','拒绝','danger'],['approve','批准本次','primary']]) {
      const button = viewButton(text,async () => {
        try { s.active = await api('/api/runs/' + run.runId + '/decisions',{method:'POST',body:{callId:p.callId,decision}}); paintRun(); }
        catch(e) { announce(e); }
      },cls,'sm');
      actions.append(button);
    }
    timeline.append(card);
  }
  const rows = new Map();
  for (const e of s.events) {
    const id = e.data?.callId;
    if (!id || !(e.type.startsWith('tool.') || ['browser.report','browser.observed','test.report','test.observed'].includes(e.type))) continue;
    if (!rows.has(id)) rows.set(id,{});
    rows.get(id)[e.type] = e;
  }
  for (const [id, data] of rows) {
    const proposed = data['tool.proposed']?.data, result = data['tool.result']?.data, started = data['tool.started']?.data;
    const name = proposed?.tool || result?.tool || started?.tool || '未知工具';
    const state = result?.status ?? (started ? 'started' : 'proposed');
    const card = mk('article','nv-card tool-card'), heading = mk('div','tool-head');
    heading.append(mk('strong','mono',testTools[name] ?? name.replace(/^localbridge_/,'')),badge(
      { ok:'成功', error:'错误 / 拒绝', unknown:'执行未知', started:'执行中', proposed:'已提议' }[state],
      ({ok:'success',error:'danger',unknown:'warning',started:'info',proposed:'warning'})[state]
    )); card.append(heading);
    if (proposed?.args) addDetails(card,'参数',proposed.args,id+':args',openKeys);
    if (started?.executionId) card.append(mk('p','mono','执行 ID · ' + started.executionId.slice(0,8)));
    if (result?.output) addDetails(card,'结果',result.output,id+':result',openKeys);
    if (result?.message) card.append(mk('p','',result.message));
    if (data['browser.observed'] || data['test.observed']) {
      const value=(data['test.observed'] ?? data['browser.observed']).data.observation;
      const observation=mk('section','nv-card browser-report');
      observation.append(mk('strong','','页面观察 · 尚未执行计划'),mk('p','',value.title),mk('div','report-url mono',value.url));
      addDetails(observation,'可见文字和控件',{text:value.text,controls:value.controls},id+':observed',openKeys);
      card.append(observation);
    }
    if (data['browser.report'] && run) {
      const value=data['browser.report'].data;
      card.append(browserReport(value,run.runId));
    }
    if (data['test.report'] && run) card.append(testReport(data['test.report'].data.report,run.runId));
    timeline.append(card);
  }
  if (!rows.size && !run?.pending) {
    const empty = mk('span','timeline-empty');
    empty.innerHTML = icon('activity');
    empty.append(document.createTextNode(active ? '模型正在处理请求。' : '开始对话后，工具调用将在这里按顺序出现。'));
    timeline.append(empty);
  }
  timeline.scrollTop = oldTimeline;
  if (follow) transcript.scrollTop = transcript.scrollHeight;
}
const testTools={navi_test_discover:'发现用例',navi_test_read:'读取用例',navi_test_observe:'观察目标网页',
  navi_test_plan:'准备测试计划',navi_test_run:'运行用例'};
const testSteps={goto:'访问页面',fill:'填写输入',click:'点击元素',expectText:'核对文本',expectVisible:'核对可见',
  select:'选择选项',check:'设置复选框',screenshot:'截图',setup:'启动浏览器'};
function paintTestApproval(card,args) {
  if (args.path) card.append(mk('p','mono','用例目录 · '+args.path));
  if (args.targetUrl) card.append(mk('p','report-url mono',args.targetUrl));
  if (args.sources?.length) card.append(mk('p','mono','来源 · '+args.sources.join('、')));
  if (Array.isArray(args.steps)) {
    const steps=mk('ol','report-steps');
    for (const {action,...fields} of args.steps) {
      const item=mk('li','');
      item.append(mk('strong','',testSteps[action] ?? action));
      if (Object.keys(fields).length) item.append(pre(fields));
      steps.append(item);
    }
    card.append(steps);
  }
  if (args.command) card.append(mk('p','','运行命令参数'),pre(args.command));
  if (!args.path && !args.targetUrl) card.append(pre(args));
}
function testReport(report,runId) {
  const box=mk('section','nv-card browser-report'), header=mk('div','report-head');
  const labels={passed:'已通过',failed:'失败',blocked:'受阻',unverified:'未验证'};
  header.append(mk('strong','','测试报告'),badge(labels[report.status] ?? '未验证',
    report.status==='passed'?'success':report.status==='failed'?'danger':'warning'));
  box.append(header,mk('p','report-url mono',report.targetUrl));
  if (report.sources?.length) box.append(mk('p','mono','来源 · '+report.sources.map(source=>source.path).join('、')));
  if (report.message) box.append(mk('p','',report.message));
  if (Array.isArray(report.steps) && report.steps.length) {
    const steps=mk('ol','report-steps');
    for (const step of report.steps) {
      const item=mk('li',step.status==='failed'?'failed':'');
      item.append(mk('span','',testSteps[step.action] ?? step.action),
        badge(step.status==='passed'?'通过':'失败',step.status==='passed'?'success':'danger'));
      if (step.error) item.append(mk('p','',step.error));
      steps.append(item);
    }
    box.append(steps);
  }
  if (report.tests) box.append(mk('p','',`通过 ${report.tests.passed} · 失败 ${report.tests.failed} · 跳过 ${report.tests.skipped}`));
  for (const item of report.artifacts ?? []) {
    if (item.mime!=='image/jpeg') continue;
    const image=mk('img','report-image');
    image.alt='隔离浏览器实际页面截图'; image.loading='lazy';
    image.src='/api/runs/'+encodeURIComponent(runId)+'/artifacts/'+encodeURIComponent(item.artifactId);
    box.append(image);
  }
  return box;
}
function browserReport(value, runId) {
  const flip = {goto:'访问页面',fill:'填写输入',click:'点击元素',expectText:'核对文本',expectVisible:'核对可见',select:'选择选项',check:'设置复选框',screenshot:'截图',setup:'启动浏览器'};
  const box = mk('section','nv-card browser-report');
  const top = mk('div','report-head');
  const labels = mk('div');
  labels.append(mk('strong','','浏览器测试报告'),mk('p','',value.report.name));
  top.append(labels,badge(value.report.status==='passed'?'已通过':'失败',value.report.status==='passed'?'success':'danger')); box.append(top);
  if (value.report.url) box.append(mk('div','report-url mono',value.report.url));
  const steps = mk('ol','report-steps');
  for (const step of value.report.steps) {
    const item = mk('li',step.status === 'failed'?'failed':'');
    item.append(mk('span','','' +(flip[step.action] ?? step.action)),badge(step.status==='passed'?'通过':'失败',step.status==='passed'?'success':'danger'));
    if (step.error) item.append(mk('p','',step.error)); steps.append(item);
  }
  box.append(steps);
  if (value.report.screenshotNote) box.append(mk('p','help',value.report.screenshotNote));
  if (value.artifactId) {
    const image = mk('img','report-image');
    image.alt='隔离浏览器实际页面截图'; image.loading='lazy';
    image.src='/api/runs/'+encodeURIComponent(runId)+'/artifacts/'+encodeURIComponent(value.artifactId);
    box.append(image);
  }
  return box;
}
function addDetails(target, title, value, key, openKeys = new Set()) {
  const details = mk('details'); details.dataset.details = key;
  details.open = openKeys.has(key); details.append(mk('summary','',title),pre(value)); target.append(details);
}
function webPage() {
  main.append(pageIntro('浏览器任务','输入网址和任务，查看执行结果。'));
  const area=mk('div','nv-stack page-content compact-settings'),panel=section('新建浏览器任务');
  const form=mk('form','nv-stack'),url=mk('input'),description=mk('textarea');
  url.type='url';url.placeholder='https://example.com/page';url.maxLength=1800;url.value=s.webDraft.url;
  description.rows=4;description.maxLength=8000;description.required=true;description.value=s.webDraft.prompt;
  description.placeholder='例如：找到产品页里的预约入口，打开后核对页面标题并截图。';
  const demo=s.status?.mode==='model-demo';
  const preset=s.status?.demoExample || '填写姓名 Ada，点击提交，确认出现 Hello Ada，并截图。';
  const available=selection(s.models.map(m=>[m.id,modelLabel(m)]),s.model,'选择模型');
  form.append(field('目标网址',url,'体验内置示例时可以不填网址。'),field('任务描述',description),field('模型',available));
  if (demo || !s.models.length) {
    const hint=mk('div','callout warm','可以先写任务草稿。运行自定义任务前，请保存有效的 URL 和 Key。');
    hint.append(actionLink('打开连接设置','#settings'));form.append(hint);
  } else {
    form.append(mk('div','callout','观察页面、生成计划和执行任务都需要确认。'));
  }
  const progress=mk('p','help');progress.setAttribute('aria-live','polite');form.append(progress);
  let state=null, submitting=false;
  const isExample=()=>s.webDraft.example && !url.value.trim() && description.value.trim()===preset;
  const needsConnection=()=>demo&&!isExample();
  const saveDraft=()=>{
    s.webDraft={url:url.value,prompt:description.value,example:isExample()};
    updateSubmit();
  };
  const submit=uiButton('运行任务','primary');submit.type='submit';
  function updateSubmit() {
    submit.disabled=submitting||(!needsConnection()&&(!state?.ready||state.state==='preparing'||!available.value));
  }
  function connectionRequired() {
    throw new Error('草稿已保留。请打开「连接设置」，填写 URL 和 Key 后再运行自定义浏览器任务。');
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if (submitting||submit.disabled) return;
    const draft=s.webDraft;
    try {
      if (needsConnection()) connectionRequired();
      if (!isExample()&&!url.value.trim()) throw new Error('请填写目标网址，或点击「体验内置示例」。');
      if (activeStatus(s.active)) throw new Error('请先结束当前运行。');
      submitting=true;updateSubmit();
      const run=await api('/api/web-tasks',{method:'POST',body:{url:url.value.trim(),prompt:description.value.trim(),model:available.value}});
      if (s.webDraft===draft) s.webDraft={url:'',prompt:'',example:false};
      await refreshAll();s.runs=[run,...s.runs.filter(prior=>prior.runId!==run.runId)];await openRun(run.runId);
    } catch(error) {announce(error);}
    finally {submitting=false;updateSubmit();}
  });
  const example=viewButton('体验内置示例',()=>{
    url.value='';description.value=preset;s.webDraft={url:'',prompt:preset,example:true};updateSubmit();description.focus();
  });
  const prepare=viewButton('准备浏览器环境',async()=>{
    prepare.disabled=true;
    try { await api('/api/web-tasks/prepare',{method:'POST'}); await poll(); }
    catch(error) { progress.textContent=error.message;prepare.disabled=false; }
  });
  const actions=mk('div','nv-row actions');actions.append(example,prepare,submit);form.append(actions);
  async function poll() {
    try {
      state=await api('/api/web-tasks/status');
      if(!form.isConnected)return;
      updateSubmit();prepare.disabled=state.state==='preparing'||state.state==='unavailable';
      progress.textContent=state.state==='preparing'?'正在准备浏览器环境…':state.message||
        (state.ready?'浏览器环境已就绪。':'还未准备浏览器环境。');
      if(state.state==='preparing')setTimeout(()=>void poll(),1200);
    } catch(error) { progress.textContent=error.message; }
  }
  updateSubmit();available.addEventListener('change',updateSubmit);
  for (const input of [url,description]) input.addEventListener('input',saveDraft);
  panel.append(form);area.append(panel);main.append(area);void poll();
}
function projectsPage() {
  main.append(pageIntro('项目与权限','授权项目文件夹，并设置读写和命令权限。'));
  const contents = mk('div','nv-stack page-content'), add = section('授权本机项目'), list = section('已授权目录');
  const sample = s.status?.sandboxPath, browserLab = s.status?.browserLabPath;
  const form = mk('form'), grid = mk('div','form-grid');
  const dir = mk('input'); dir.placeholder = '/path/to/project'; dir.required = true;
  const name = mk('input'); name.placeholder = '可选 · 显示名称'; name.maxLength = 100;
  grid.append(field('项目目录 · 绝对路径',dir),field('项目名称',name)); form.append(grid);
  submitButton(form,'注册为只读项目',async () => {
    const value = await api('/api/projects',{method:'POST',body:{path:dir.value,name:name.value}});
    s.projectId = value.project.id; await refreshAll(); render(); toast('已注册：' + value.project.name);
  });
  if (sample) {
    const intro = mk('div','callout');
    intro.append(document.createTextNode('也可以先使用本机示例目录。'),viewButton('填入示例目录',() => { dir.value = sample; name.value = 'Navi 示例项目'; dir.focus(); },'secondary','sm'));
    if (browserLab) intro.append(viewButton('填入浏览器用例目录',() => {
      dir.value = browserLab; name.value = 'Navi 浏览器任务'; dir.focus();
    },'secondary','sm'));
    add.append(intro);
  } else if (s.status?.mode === 'demo') {
    add.append(mk('div','callout warm','当前为完整模拟。示例目录与权限存储在内存中，不读取本机路径。'));
  }
  add.append(form); list.append(mk('p','','读写权限允许提出文件修改；发送给 Runner 前仍要人工确认。'));
  for (const project of s.projects) {
    const row = mk('article','list-row'), description = mk('div','row-desc');
    description.append(mk('strong','',projectLabel(project.name)),mk('div','meta mono',project.id));
    const access = selection([['read-only','只读'],['read-write','可读写']],project.accessMode);
    const execution = selection([['disabled','命令关闭'],['safe-only','安全命令'],['project-code','项目命令']],project.executionMode);
    access.dataset.size=execution.dataset.size='sm';
    access.setAttribute('aria-label',project.name + '文件权限'); execution.setAttribute('aria-label',project.name + '命令权限');
    const adjust = () => { execution.disabled = access.value === 'read-only'; if (execution.disabled) execution.value = 'disabled'; };
    access.addEventListener('change',adjust); adjust();
    const button = viewButton('保存权限',async () => {
      button.disabled = true;
      try {
        await api('/api/projects/'+encodeURIComponent(project.id)+'/permissions',{method:'PATCH',body:{accessMode:access.value,executionMode:execution.value}});
        await refreshAll(); render(); toast('已读回项目权限');
      } catch(e) { announce(e); await refreshAll(); render(); }
    },'secondary','sm');
    const go = viewButton('对话',() => {
      if (activeStatus(s.active)) { toast('当前仍有运行，请先完成或取消。',true); return; }
      clearActive(); s.projectId = project.id; goto('chat');
    },'ghost','sm');
    const actions = mk('div','nv-row row-actions'); actions.append(access,execution,button,go); row.append(description,actions); list.append(row);
  }
  if (!s.projects.length) list.append(mk('div','empty-state','尚未注册任何项目。注册后可以在对话工作区选择它。'));
  contents.append(add,list); main.append(contents);
}
function approvalPage() {
  const header = pageIntro('审批中心','审批由 Nexus 保存和执行，工作台集中展示待处理请求。');
  const refresh = viewButton('刷新审批',() => void loadApprovals().catch(announce),'secondary','sm');
  header.append(refresh); main.append(header);
  const area = mk('div','nv-stack page-content'); area.id = 'approval-list'; main.append(area);
  paintApprovals(); void loadApprovals().catch(announce);
}
async function loadApprovals() {
  const value = await api('/api/nexus/approvals'); s.approvals = value.approvals;
  updateShell(); if (s.page === 'approvals') paintApprovals();
}
function paintApprovals() {
  const area = $('approval-list'); if (!area) return;
  area.replaceChildren();
  const focus = new URLSearchParams(location.hash.split('?')[1] ?? '').get('approvalId');
  const pending = section('等待决定'), prior = section('历史审批');
  if (s.active?.pending?.kind === 'workbench') {
    const direct = mk('div','callout warm');
    direct.append(document.createTextNode('当前对话还在等待工作台侧确认。'),viewButton('返回工具轨迹',() => goto('chat'),'secondary','sm'));
    pending.append(direct);
  }
  for (const item of s.approvals) {
    const requested = item.status === 'pending';
    const row = mk('article','list-row' + (item.id === focus ? ' approval-focus' : ''));
    const left = mk('div','row-desc'); left.append(mk('strong','',item.summary || item.operation),mk('div','meta',[
      item.projectId, item.operation, item.id
    ].filter(Boolean).join(' · ')));
    const right = mk('div','nv-row row-actions');
    right.append(badge(labelFor('状态',item.status), requested ? 'warning' :
      ['denied','expired'].includes(item.status) ? 'danger' : ['approved','consumed'].includes(item.status) ? 'success' : 'neutral'));
    if (requested) for (const [key, text, skin] of [['deny','拒绝','danger'],['approve','批准','primary']]) {
      const b = viewButton(text,async () => {
        for (const control of right.querySelectorAll('button')) control.disabled = true;
        try {
          await api('/api/nexus/approvals/'+encodeURIComponent(item.id)+'/resolve',{method:'POST',body:{action:key}});
          await loadApprovals(); toast(key === 'approve' ? 'Nexus 已批准' : 'Nexus 已拒绝');
        } catch(e) { for (const control of right.querySelectorAll('button')) control.disabled = false; announce(e); }
      },skin,'sm'); right.append(b);
    }
    row.append(left,right); (requested ? pending : prior).append(row);
  }
  if (!s.approvals.some(a => a.status === 'pending')) pending.append(mk('div','empty-state','没有等待决定的 Nexus 审批。'));
  if (!s.approvals.some(a => a.status !== 'pending')) prior.append(mk('div','empty-state','没有历史审批。'));
  if (s.active?.pending?.kind === 'nexus' || focus) pending.append(viewButton('返回对话',() => goto('chat'),'secondary','sm'));
  area.append(pending,prior);
}
function sessionsPage() {
  main.append(pageIntro('项目会话','查看项目的会话记录。'));
  const contents = mk('div','nv-stack page-content'), panel = section('项目工作流');
  const projects = selection(s.projects.map(x => [x.id,projectLabel(x.name)]),s.projectId,'选择项目');
  const rows = mk('div'); const buttons = mk('div','nv-row actions');
  let load = 0, cursor = null;
  const next = viewButton('加载下一页',() => void reload(false),'secondary'); next.hidden = true;
  const ping = viewButton('刷新',() => void reload(true)); buttons.append(ping,next);
  const reload = async (reset) => {
    const ticket = ++load;
    if (reset) { cursor = null; rows.replaceChildren(); next.hidden = true; }
    if (!projects.value) { rows.replaceChildren(mk('p','empty-state','先注册一个项目。')); return; }
    next.disabled = true; ping.disabled = true;
    try {
      const query = new URLSearchParams({limit:'2',...(cursor ? {cursor} : {})});
      const page = await api('/api/projects/'+encodeURIComponent(projects.value)+'/sessions?'+query);
      if (ticket !== load || s.page !== 'sessions') return;
      for (const item of page.sessions) {
        const row = mk('article','list-row'), left = mk('div','row-desc');
        left.append(mk('strong','',item.title || item.goal || item.sessionId),mk('div','meta mono',item.sessionId));
        const right = mk('div','nv-row row-actions');
        right.append(badge(labelFor('状态',item.state),item.state==='active'?'info':item.state==='completed'?'success':'neutral'),viewButton('查看事件',async () => {
          if (row.nextElementSibling?.dataset.session === item.sessionId) { row.nextElementSibling.remove(); return; }
          const eventsBox = mk('div'); eventsBox.dataset.session = item.sessionId;
          const list = mk('div'); let eventCursor = null;
          const more = viewButton('下一页事件',() => void fetchEvents(),'secondary','sm'); more.hidden = true;
          eventsBox.append(list,more); row.after(eventsBox);
          async function fetchEvents() {
            more.disabled = true;
            try {
              const query = new URLSearchParams({ projectId:projects.value, limit:'8', ...(eventCursor ? {cursor:eventCursor} : {}) });
              const details = await api('/api/nexus/sessions/'+encodeURIComponent(item.sessionId)+'/events?'+query);
              for (const event of details.events) list.append(pre(event));
              if (!details.events.length && !eventCursor) list.append(mk('p','help','暂无事件'));
              eventCursor = details.nextCursor; more.hidden = !details.hasMore || !eventCursor;
            } catch (err) { announce(err); } finally { more.disabled = false; }
          }
          await fetchEvents();
        },'secondary','sm'));
        row.append(left,right); rows.append(row);
      }
      if (reset && !page.sessions.length) rows.append(mk('p','empty-state','此项目在 Nexus 中还没有保存工作流。'));
      cursor = page.nextCursor; next.hidden = !page.hasMore || !cursor;
    } catch(e) { if (ticket === load) rows.append(mk('div','empty-state',e.message)); }
    finally { if (ticket === load) { next.disabled = false; ping.disabled = false; } }
  };
  projects.addEventListener('change',()=>void reload(true)); panel.append(field('选择项目',projects),buttons,rows);
  contents.append(panel); main.append(contents); void reload(true);
}
function settingsPage() {
  main.append(pageIntro('连接设置','保存 URL 和 Key 后，即可在对话中选择模型。'));
  const area=mk('div','nv-stack page-content compact-settings'), panel=section('模型 API');
  if (s.status?.mode === 'demo') {
    panel.append(mk('p','','完整模拟模式不连接真实工具，请启动真实工具链后配置。'));
  } else {
    const draft=s.connection, form=mk('form','nv-stack'), baseUrl=mk('input'), key=mk('input');
    baseUrl.type='url'; baseUrl.required=true; baseUrl.value=draft.baseUrl ?? (s.status?.urls.cpr || 'http://127.0.0.1:8080/v1');
    key.id='model-api-key'; key.type='password'; key.autocomplete='off'; key.value=draft.clientKey;
    key.placeholder=s.status?.cpr.configured?'•••••••• · 已配置，留空沿用':'输入模型网关签发的 Key';
    form.append(field('API Base URL',baseUrl,'如使用本机 CPR： http://127.0.0.1:8080/v1。'),field('API Key',key));
    const note=mk('div','callout'); note.setAttribute('role','status'); form.append(note);
    const syncForm=()=>{
      baseUrl.disabled=key.disabled=save.disabled=draft.pending;
      note.textContent=draft.message; note.hidden=!draft.message; note.classList.toggle('warm',draft.error);
    };
    const save=uiButton('保存并连接','primary'); save.type='submit';
    const actions=mk('div','nv-row actions'); actions.append(save); form.append(actions);
    form.addEventListener('input',()=>{
      draft.baseUrl=baseUrl.value; draft.clientKey=key.value;
      draft.message=''; draft.error=false; syncForm();
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if (draft.pending || draft!==s.connection) return;
      draft.baseUrl=baseUrl.value; draft.clientKey=key.value;
      draft.pending=true; draft.error=false; draft.message='正在验证并保存连接…'; syncForm();
      try {
        const result=await api('/api/settings/model',{method:'POST',body:{baseUrl:draft.baseUrl,clientKey:draft.clientKey}});
        if (draft!==s.connection) return;
        draft.baseUrl=result.baseUrl; draft.clientKey=''; key.value='';
        s.model=result.defaultModel;
        await refreshAll();
        if (draft!==s.connection) return;
        draft.message='连接已保存，可在对话中选择模型。';
        if (s.page==='chat' && $('model-select')) {
          const model=$('model-select');
          const available=selection(s.models.map(m=>[m.id,modelLabel(m)]),s.model,'选择模型');
          model.replaceChildren(...available.children);
          model.title=model.selectedOptions[0]?.textContent || '选择模型';
          paintRun();
        } else if (s.page==='web') render();
        toast('连接已保存');
      } catch(error) {
        if (draft!==s.connection) return;
        draft.error=true; draft.message=error.message;
        if (s.page!=='settings') toast(error.message,true);
      } finally {
        draft.pending=false;
        if (draft===s.connection && s.page==='settings') {
          if (form.isConnected) {
            baseUrl.value=draft.baseUrl; key.value=draft.clientKey;
            key.placeholder=s.status?.cpr.configured?'•••••••• · 已配置，留空沿用':'输入模型网关签发的 Key';
            syncForm();
          } else render();
        }
      }
    });
    syncForm(); panel.append(form);
  }
  area.append(panel);main.append(area);
}
function readPairIntent() {
  if (!location.hash.startsWith('#extension-pair=')) return;
  const id=location.hash.match(/^#extension-pair=([A-Za-z0-9_-]{43})$/)?.[1];
  s.pairIntent={ id };
  history.replaceState(null,'',location.pathname+location.search+'#extension');
}
function wakeExtension(extensionId,requestId) {
  const runtime=globalThis.chrome?.runtime;
  try { runtime?.sendMessage?.(extensionId,{type:'navi.pair.approved',requestId},()=>{void runtime.lastError;}); }
  catch { /* Opening the extension popup can also complete pairing. */ }
}
function extensionPairPanel() {
  const panel=section('连接 Navi Link'), intent=s.pairIntent;
  const note=mk('div','callout'); note.setAttribute('role','status');
  if (s.status?.mode==='demo') {
    panel.append(mk('p','','完整模拟模式无法连接网页扩展。请双击 Navi.app 打开本机工具链。'));
    return panel;
  }
  if (!intent) {
    panel.append(mk('p','','从 Chrome 工具栏打开 Navi Link 侧栏，选择「连接到 Navi」，然后在这里确认项目。'));
    panel.append(mk('div','callout','侧栏使用 Navi 已保存的模型 API。默认允许读取所选项目，也可在配对时授权运行测试。每次工具请求仍须确认。'));
    return panel;
  }
  panel.append(note);
  const messages={ approved:'已批准。请返回扩展查看连接状态。', consumed:'配对请求已处理。请返回扩展查看连接状态。',
    denied:'已取消配对。可以从 Navi Link 重新发起。', expired:'配对请求已过期。请在 Navi Link 重新发起。' };
  const warn=message=>{note.classList.add('warm'); note.textContent=message;};
  if (!intent.id) {
    warn('配对链接无效。请在 Navi Link 重新发起。'); return panel;
  }
  const endpoint='/api/extension/pair/'+intent.id;
  note.textContent='正在检查配对请求…';
  void api(endpoint).then(request=>{
    if (!panel.isConnected || s.pairIntent!==intent) return;
    if (request.state!=='pending') {
      note.textContent=messages[request.state] || '配对请求不可用。请在 Navi Link 重新发起。'; return;
    }
    if (request.capabilities?.splitAutomation!==true) {
      warn('工作台后台仍是旧版本，暂不支持分别授权浏览器和本机文件操作。请停止旧 Navi 服务后重新启动，再从扩展重新发起连接；仅刷新页面不会更新后台。'); return;
    }
    note.textContent='允许 Navi Link 使用 Navi 已保存的模型聊天。默认读取所选项目，每次工具操作须在扩展中确认。';
    const form=mk('form','nv-stack'), projects=s.projects.filter(project=>project.enabled && ['read-only','read-write'].includes(project.accessMode));
    const project=selection(projects.map(item=>[item.id,projectLabel(item.name)]),'','选择项目');
    const failure=mk('div','callout warm'); failure.hidden=true; failure.setAttribute('role','alert');
    const testChoice=mk('label','nv-row pair-test-choice'), testing=mk('input');
    testing.type='checkbox'; testing.setAttribute('aria-describedby','pair-testing-help');
    testChoice.append(testing,mk('span','','允许运行测试'));
    const automationChoice=mk('label','nv-row pair-test-choice'), automation=mk('input');
    automation.type='checkbox';
    automationChoice.append(automation,mk('span','','允许浏览器操作'));
    const fileChoice=mk('label','nv-row pair-test-choice'), files=mk('input');
    files.type='checkbox';fileChoice.append(files,mk('span','','允许本机文件操作'));
    const fileHelp=mk('p','help','在 Finder 打开项目目录，以及创建、修改文件和建目录。修改仍需项目读写权限，每次操作须确认；不包含浏览器操作或任意命令。未勾选时保留项目只读工具。');
    const automationHelp=mk('p','help','在当前 Chrome/Edge 打开网页、搜索、读取、点击和填写。每次操作须确认；不授予目录打开或文件修改权限。');
    const help=mk('p','help','每次测试仍须核对目标网址与步骤。已有测试脚本还需要来源项目的读写和命令权限。');
    help.id='pair-testing-help';
    form.append(field('选择项目',project),testChoice,help,automationChoice,automationHelp,fileChoice,fileHelp,failure);
    if (!projects.length) {
      const projectsLink=mk('a','','打开项目与权限'); projectsLink.href='#projects';
      const help=mk('p','','请先授权并启用一个项目。'); help.append(' ',projectsLink); form.append(help);
    }
    const buttons=mk('div','nv-row actions'), approve=uiButton('连接','primary'), deny=uiButton('取消');
    approve.type='submit'; deny.type='button'; buttons.append(approve,deny); form.append(buttons); panel.append(form);
    let pending=false;
    const sync=()=>{ project.disabled=pending || !projects.length; testing.disabled=pending || !project.value; automation.disabled=pending || !project.value; files.disabled=pending || !project.value;
      approve.disabled=pending || !project.value; deny.disabled=pending; };
    const submit=async operation=>{
      if (pending || (operation==='approve' && !project.value)) return;
      pending=true; failure.hidden=true; sync();
      try {
        const value=await api(endpoint+'/'+operation,{method:'POST',
          body:operation==='approve'?{projectId:project.value,...(testing.checked?{access:'testing'}:{}),browserAutomation:automation.checked,fileOperations:files.checked}:{}});
        if (value.state==='approved') wakeExtension(request.extensionId,intent.id);
        note.textContent=messages[value.state] || '配对请求已处理。'; form.remove();
      } catch(error) { failure.textContent=error.message; failure.hidden=false; }
      finally { pending=false; sync(); }
    };
    project.addEventListener('change',()=>{testing.checked=false; automation.checked=false; files.checked=false; sync();});
    form.addEventListener('submit',event=>{event.preventDefault(); void submit('approve');});
    deny.addEventListener('click',()=>void submit('deny'));
    sync();
  }).catch(error=>{if (panel.isConnected) warn(error.message);});
  return panel;
}
function extensionPage() {
  main.append(pageIntro('网页扩展','在 Chrome 侧栏使用 Navi 的模型聊天，或用 ChatGPT、DeepSeek 的网页账号连接本机项目。'));
  const area = mk('div','nv-stack page-content compact-settings'), advanced=mk('details','nv-card');
  advanced.append(mk('summary','','高级：手动连接'));
  const steps=mk('div');
  steps.append(mk('p','','需要手动配置时，在 Navi Link 的高级设置填写项目 ID 和单独签发的 Nexus 令牌。'));
  const access = selection([['read','只读'],['read-write','文件读写'],['read-write-execute','文件读写与命令执行']], 'read');
  const form = mk('form','nv-stack'), secret = mk('div'); secret.hidden = true;
  form.append(field('独立令牌权限',access,'令牌有效期为 7 天。实际操作仍受 Nexus 项目、令牌和审批规则约束。'));
  const button = submitButton(form,'生成扩展令牌',async () => {
    const result = await api('/api/extension-token',{method:'POST',body:{access:access.value}});
    secret.hidden = false; secret.replaceChildren(mk('p','help','令牌只展示这一次。复制到扩展设置，然后隐藏。'),
      mk('pre','codebox secret',result.token),
      viewButton('复制令牌',async () => {
        try { await navigator.clipboard.writeText(result.token); toast('令牌已复制'); }
        catch { toast('无法访问剪贴板，可选中令牌后手动复制。',true); }
      }),
      viewButton('隐藏', () => { secret.replaceChildren(); secret.hidden = true; }));
  });
  if (s.status?.mode === 'demo') button.disabled = true;
  steps.append(mk('div','callout','Nexus MCP · ' + (s.status?.urls.nexus || 'http://127.0.0.1:18080/mcp')),form,secret);
  advanced.append(steps); area.append(extensionPairPanel(),advanced); main.append(area);
}
function deploymentsPage() {
  main.append(pageIntro('部署管理','查看应用状态、执行更新或重启，并跟踪操作结果。'));
  const area = mk('div','nv-stack page-content');
  const controls = section('应用操作'), history = section('最近操作');
  const notice = mk('p','help'); notice.setAttribute('role','status');
  const buttons = mk('div','nv-row actions'), panelLink = actionLink('打开管理面板','/api/deployments/panel');
  panelLink.target = '_blank'; panelLink.rel = 'noopener noreferrer'; panelLink.hidden = true;
  const actionButtons = {};
  const labels = {inspect:'检查状态',update:'一键更新',restart:'重启应用'};
  let data = null, busy = false;
  const request = async actionName => {
    if (busy || !data?.configured) return;
    const retry = s.deploymentRequest;
    if (retry && (retry.action !== actionName || retry.revision !== data.revision)) throw new Error('有请求尚未确认，请先重试原操作以核对结果。');
    if (!retry && actionName !== 'inspect') {
      const detail = actionName === 'update' ? '拉取 Compose 文件指定的镜像并重建容器，可能短暂中断服务。此操作不自动备份或回滚。' : '重启应用容器，可能短暂中断服务。';
      if (!window.confirm(labels[actionName] + '当前部署应用？' + '\n\n' + detail)) return;
    }
    const payload = retry || {action:actionName,revision:data.revision,requestId:crypto.randomUUID()};
    s.deploymentRequest = payload; busy = true; paint();
    try {
      await api('/api/deployments/jobs',{method:'POST',body:payload});
      s.deploymentRequest = null;
      await reload();
    } catch (error) {
      if (error.status >= 400 && error.status < 500) s.deploymentRequest = null;
      notice.textContent = error.message + ' 可重试同一操作核对结果，系统不会重复执行同一请求。';
      // A persisted receipt also resolves a lost HTTP response.
      try { await reload(); } catch {}
      throw error;
    } finally { busy = false; paint(); }
  };
  for (const [key,label] of Object.entries(labels)) {
    const button = uiButton(label,key === 'update' ? 'primary' : 'secondary');
    button.addEventListener('click',() => void request(key).catch(announce));
    actionButtons[key] = button; buttons.append(button);
  }
  buttons.append(panelLink);
  controls.append(mk('p','','更新使用服务器现有 Compose 配置。固定标签或 digest 不会自动切换版本；请先在服务器或管理面板修改镜像版本。'),buttons,notice);
  area.append(controls,history); main.append(area);
  const stageLabels = {connecting:'连接服务器',checked:'Compose 配置已检查',pulled:'镜像已拉取',updated:'容器已更新并通过就绪检查',restarted:'重启命令已完成',containers:'读取容器状态'};
  const statuses = {running:'执行中',completed:'命令已完成',failed:'失败',unknown:'结果未知',unverified:'已检查，原结果未确认'};
  function paint() {
    if (!area.isConnected || !data) return;
    const running = data.jobs.some(job => job.status === 'running');
    const unknown = data.jobs.some(job => job.status === 'unknown');
    const unresolved = s.deploymentRequest;
    const latest = data.jobs.find(job => job.revision === data.revision);
    const verified = latest?.status === 'completed' && latest.containers.length;
    for (const [key,button] of Object.entries(actionButtons)) {
      button.disabled = busy || !data.enabled || !data.configured || running || (key !== 'inspect' && (unknown || !verified)) || Boolean(unresolved && unresolved.action !== key);
      button.textContent = unresolved?.action === key ? '重试并核对' + labels[key] : labels[key];
    }
    panelLink.hidden = !data.hasPanel;
    if (!data.enabled) notice.textContent = '模拟模式不执行服务器操作。';
    else if (!data.configured) notice.textContent = '尚未配置部署目标。请先在本机完成配置。';
    else if (unknown) notice.textContent = '上次执行结果未知。检查状态会尝试取得服务器操作锁，确认先前命令已结束后再允许更新。';
    else if (!unresolved) notice.textContent = !verified && data.configured ? '请先检查状态，确认当前 Compose 项目存在容器后再更新或重启。' : '';
    history.replaceChildren(mk('h2','','最近操作'));
    if (!data.jobs.length) history.append(mk('p','empty-state','尚未执行服务器操作。'));
    for (const [index,job] of data.jobs.entries()) {
      const details = mk('details','tool-card'); details.open = index === 0;
      const summary = mk('summary');
      summary.append(document.createTextNode(`${labels[job.action] || job.action} · ${new Date(job.startedAt).toLocaleString()} `),
        badge(statuses[job.status] || job.status,job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : 'warning'));
      details.append(summary,mk('p','help',stageLabels[job.stage] || ''),mk('p','',job.message || '服务器操作正在进行；离开此页不会取消任务。'));
      for (const container of job.containers) {
        const row = mk('div','list-row'), description = mk('div','row-desc');
        description.append(mk('strong','',container.service || '服务'),mk('div','meta mono',container.image));
        row.append(description,badge([container.state,container.health].filter(Boolean).join(' · ') || '未知',
          container.state === 'running' && container.health !== 'unhealthy' ? 'info' : 'warning')); details.append(row);
      }
      if (job.status === 'completed' && !job.containers.length) details.append(mk('p','help','当前项目没有容器，请核对项目名和 Compose 文件。'));
      history.append(details);
    }
  }
  async function reload() {
    const next = await api('/api/deployments');
    if (!area.isConnected || !s.csrf) return;
    let changed = JSON.stringify(data) !== JSON.stringify(next);
    data = next;
    if (s.deploymentRequest && (data.jobs.some(job => job.id === s.deploymentRequest.requestId) || s.deploymentRequest.revision !== data.revision)) {
      s.deploymentRequest = null; changed = true;
    }
    if (changed) paint();
  }
  for (const button of Object.values(actionButtons)) button.disabled = true;
  async function poll() {
    if (!area.isConnected || !s.csrf) return;
    try { await reload(); } catch (error) { notice.textContent = error.message; }
    if (area.isConnected && s.csrf) setTimeout(() => void poll(),2000);
  }
  void poll();
}

function render() {
  if (!s.csrf) return;
  const name = location.hash.slice(1).split('?')[0];
  const previous = s.page;
  s.page = Object.hasOwn(navNames,name) ? name : 'chat';
  if (previous !== s.page) window.scrollTo(0,0);
  updateShell();
  main.classList.toggle('chat-page',s.page==='chat');
  main.replaceChildren();
  ({chat, web:webPage, projects:projectsPage, approvals:approvalPage, sessions:sessionsPage, settings:settingsPage, deployments:deploymentsPage, extension:extensionPage })[s.page]();
}
async function enter(csrf) {
  s.csrf = csrf; $('login').hidden = true; $('workspace').hidden = false; window.scrollTo(0,0);
  render(); await refreshAll(); render();
  const inflight = s.runs.find(activeStatus);
  if (inflight) {
    s.active = inflight; s.events = []; s.cursor = 0; chooseRunContext(inflight);
    const ticket = ++s.loadId; if (s.page === 'chat') render(); void polling(ticket);
  }
}
$('login-form').addEventListener('submit',async e => {
  e.preventDefault(); const input = $('operator'); const error = $('login-error'); const button = e.target.querySelector('button');
  button.disabled = true; error.textContent = '';
  try { const value = await api('/api/operator/login',{method:'POST',body:{token:input.value}}); input.value=''; await enter(value.csrf); }
  catch(err) { error.textContent = err.message; } finally { button.disabled = false; }
});
$('refresh').addEventListener('click',()=>void refreshAll({notify:true}).then(render).catch(announce));
$('new-chat').addEventListener('click',newChat);
setDesktopSidebar(desktopSidebarCollapsed(),false);
$('desktop-sidebar-toggle').addEventListener('click',() => setDesktopSidebar(!$('workspace').classList.contains('sidebar-collapsed')));
$('sidebar-toggle').addEventListener('click',() => setMobileSidebar($('sidebar-toggle').getAttribute('aria-expanded') !== 'true'));
$('sidebar-scrim').addEventListener('click',() => {setMobileSidebar(false); $('sidebar-toggle').focus();});
$('nav').addEventListener('click',() => setMobileSidebar(false));
document.addEventListener('pointerdown', e => {
  const menu = $('composer-menu');
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
  const menu = $('composer-menu');
  if (menu?.open) {menu.open = false; menu.querySelector('summary').focus();}
  else if ($('sidebar-toggle').getAttribute('aria-expanded') === 'true') {setMobileSidebar(false); $('sidebar-toggle').focus();}
});
narrowSidebar.addEventListener('change',() => setMobileSidebar(false));
window.addEventListener('resize',sizePrompt);
$('logout').addEventListener('click',async () => { try { await api('/api/operator/logout',{method:'POST'}); } catch {} s.pairIntent=null; lock(); });
window.addEventListener('hashchange',() => {readPairIntent(); setMobileSidebar(false); render();});
readPairIntent();
const launchTag=location.hash.match(/^#login-ticket=([A-Za-z0-9_-]{43})$/);
if (launchTag) {
  history.replaceState(null,'',location.pathname+location.search+'#chat');
  try {
    const session=await api('/api/operator/ticket',{method:'POST',body:{ticket:launchTag[1]}});
    await enter(session.csrf);
  } catch (err) { lock();$('login-error').textContent=err.message; }
} else {
  if (location.hash.startsWith('#login-ticket=')) {
    history.replaceState(null,'',location.pathname+location.search+'#chat');
    $('login-error').textContent='打开链接已失效，请重新双击「Navi.app」。';
  }
  try { const current=await api('/api/operator/session');await enter(current.csrf); } catch { lock(); }
}
