import { filesPage } from './files-ui.js';
const $ = (id) => document.getElementById(id),
  page = $('page'),
  nav = $('nav');
let me = null,
  chatId = null,
  view = 'chat',
  timer = 0;
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const notice = (text) => {
  $('status').textContent = text;
};
async function api(path, body) {
  const r = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-navi-web': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const v = await r.json();
  if (!r.ok) {
    if (r.status === 401 && me) {
      me = null;
      chatId = null;
      render();
    }
    const e = Error(v.error || '请求失败');
    e.status = r.status;
    throw e;
  }
  return v;
}
const onAction = (b, fn) => async (event) => {
  event.preventDefault();
  if (b.disabled) return;
  b.disabled = true;
  notice('');
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  } finally {
    b.disabled = false;
  }
};
const button = (text, fn, primary = false) => {
  const b = el('button', text, 'nv-button');
  b.type = 'button';
  if (primary) b.dataset.variant = 'primary';
  b.onclick = onAction(b, fn);
  return b;
};
const card = (root, title) => {
  const box = el('article', null, 'nv-card');
  box.append(el('h2', title));
  root.append(box);
  return box;
};
function form(root, fields, submit, fn) {
  const f = el('form'),
    controls = {};
  for (const [key, title, type = 'text', value = ''] of fields) {
    const l = el('label', title);
    let input;
    if (Array.isArray(type)) {
      input = el('select', null, 'nv-select');
      for (const [id, name] of type) input.add(new Option(name, id));
    } else {
      input = el(type === 'area' ? 'textarea' : 'input', null, type === 'area' ? 'nv-textarea' : 'nv-input');
      if (type !== 'area') input.type = type;
      input.required = key !== 'content';
      if (type === 'password') {
        input.autocomplete =
          key === 'old' || (key === 'password' && !me) ? 'current-password' : 'new-password';
      }
    }
    if (value) input.value = value;
    if (key === 'name' && !me) input.autocomplete = 'username';
    l.append(input);
    f.append(l);
    controls[key] = input;
  }
  const b = el('button', submit, 'nv-button');
  b.dataset.variant = 'primary';
  b.type = 'submit';
  f.append(b);
  root.append(f);
  f.onsubmit = onAction(b, () => fn(Object.fromEntries(Object.entries(controls).map(([k, x]) => [k, x.value]))));
  return controls;
}
function authPage(root) {
  const c = card(root, '登录团队网站');
  c.append(el('p', '使用管理员分配的个人账号登录。'));
  form(
    c,
    [
      ['name', '用户名'],
      ['password', '密码', 'password']
    ],
    '登录',
    async (data) => {
      await api('login', data);
      await load();
    }
  );
}
function passwordPage(root) {
  const c = card(root, me.mustChange ? '首次使用：请设置个人密码' : '修改密码');
  c.append(el('p', '修改后当前账号的所有网站会话、插件和设备连接都将失效。'));
  form(
    c,
    [
      ['old', '当前密码', 'password'],
      ['next', '新密码（至少 12 个字符）', 'password']
    ],
    '保存新密码',
    async (data) => {
      await api('password', data);
      me = null;
      chatId = null;
      render();
      notice('密码已修改，请重新登录。');
    }
  );
}
async function chats(root) {
  const c = card(root, '我的对话');
  const list = await api('chats');
  if (!root.isConnected) return;
  const choices = el('select', null, 'nv-select');
  choices.setAttribute('aria-label', '选择对话');
  choices.add(new Option('新对话', ''));
  for (const row of list) choices.add(new Option(row.title, row.id));
  choices.value = chatId || '';
  choices.onchange = () => {
    chatId = choices.value || null;
    render();
  };
  c.append(choices);
  if (chatId) {
    const d = await api('chats/' + chatId);
    for (const m of d.messages) c.append(el('h3', m.role === 'user' ? '你' : 'Navi'), el('pre', m.text));
  }
  if (!me?.model) {
    c.append(el('p', '团队模型尚未配置，请联系管理员。'));
    return;
  }
  c.append(el('p', '当前模型：' + me.model));
  form(c, [['text', '消息', 'area']], '发送', async ({ text }) => {
    const reply = await api('chats/send', { text, id: chatId });
    if (root.isConnected) {
      chatId = reply.id;
      render();
    }
  });
}
async function connections(root) {
  const c = card(root, '连接插件或本机设备');
  c.append(
    el(
      'p',
      '仅为你正在使用的插件或电脑生成配对码。它只能使用一次，两分钟后失效。插件仅可访问你的团队对话；设备连接限定到本机选定的项目。'
    )
  );
  const code = el('output');
  const row = el('div', null, 'row');
  for (const [kind, title] of [
    ['plugin', '连接 Navi Link'],
    ['device', '连接本机目录']
  ])
    row.append(
      button(title, async () => {
        const r = await api('connections/code', { kind });
        code.replaceChildren(
          el(
            'p',
            kind === 'plugin'
              ? '打开 Navi Link 设置 → 团队网站，输入本站地址和配对码。'
              : '在自己的电脑运行 npm run team:device，按提示输入配对码。'
          ),
          el('pre', r.code)
        );
        clearTimeout(timer);
        timer = setTimeout(() => code.replaceChildren(el('p', '配对码已过期。')), 120000);
      })
    );
  c.append(row, code);
  const d = card(root, '我的连接');
  d.append(button('刷新连接', render));
  const items = await api('connections');
  if (!items.length) d.append(el('p', '尚未绑定插件或设备。'));
  for (const x of items) {
    const r = el('div', null, 'item');
    r.append(
      el(
        'p',
        x.kind === 'plugin'
          ? '插件 · ' + x.label
          : `设备 · ${x.label} / ${x.project} · ${Date.now() - x.seen < 30000 ? '在线' : '离线'}`
      ),
      button('撤销连接', async () => {
        if (confirm('撤销 ' + x.label + ' 的连接？')) {
          await api('connections/revoke', { id: x.id });
          render();
        }
      })
    );
    d.append(r);
  }
}
async function tasks(root) {
  const c = card(root, '本地目录任务');
  const devices = (await api('connections')).filter(
    (x) => x.kind === 'device' && Date.now() - x.seen < 30000
  );
  if (!devices.length) c.append(el('p', '没有在线设备。请在「我的连接」绑定项目并保持本机执行端运行。'));
  else {
    const files = devices.some((device) => device.canCreate) ? await api('files') : [];
    const { device, action, source, content } = form(
      c,
      [
        ['device', '设备与目录', devices.map((x) => [x.id, x.label + ' / ' + x.project])],
        [
          'action',
          '任务',
          [
            ['list', '列出目录'],
            ['read', '读取文本'],
            ['create', '新建文件']
          ]
        ],
        ['path', '项目内相对路径', 'text', '.'],
        [
          'source',
          '新文件内容来源',
          [['', '手动输入'], ...files.map((x) => [x.id, x.name + ' · ' + x.owner + ' · v' + x.version])]
        ],
        ['content', '新文件内容', 'area']
      ],
      '提交到本机确认',
      async (data) => {
        if (data.action === 'create' && data.source) {
          data.fileId = data.source;
          data.fileVersion = files.find((x) => x.id === data.source).version;
        }
        delete data.source;
        await api('tasks', data);
        render();
      }
    );
    const sync = () => {
      action.options[2].disabled = !devices.find((x) => x.id === device.value)?.canCreate;
      if (action.selectedOptions[0]?.disabled) action.value = 'list';
      source.parentNode.hidden = action.value !== 'create';
      content.parentNode.hidden = action.value !== 'create' || !!source.value;
    };
    source.onchange = device.onchange = action.onchange = sync;
    sync();
  }
  const d = card(root, '最近任务');
  d.append(button('刷新任务状态', render));
  for (const t of await api('tasks')) {
    const item = el('details', null, 'item');
    const names = { list: '列目录', read: '读取', create: '新建' },
      states = {
        queued: '等待设备领取',
        claimed: '等待本机确认或执行',
        completed: '已完成',
        denied: '已拒绝',
        failed: '失败',
        unknown: '结果未知',
        expired: '已过期',
        cancelled: '已取消'
      };
    item.append(
      el('summary', `${names[t.action]} ${t.path} · ${states[t.status]}`),
      el('pre', t.result || '暂无结果')
    );
    if (t.status === 'completed')
      form(
        item,
        [['name', '保存结果为任务文件', 'text', '任务结果.txt']],
        '保存为私有文件',
        async ({ name }) => {
          await api('files/from-task', { task: t.id, name });
          view = 'files';
          render();
        }
      );
    d.append(item);
  }
}
async function accounts(root) {
  const c = card(root, '创建成员账号');
  form(
    c,
    [
      ['name', '用户名（3–48 位字母、数字、点、短横线或下划线）'],
      ['password', '临时密码（至少 12 个字符）', 'password']
    ],
    '创建成员',
    async (data) => {
      await api('admin/accounts', data);
      render();
      notice('成员已创建，首次登录需要改密。');
    }
  );
  const d = card(root, '账号管理');
  for (const u of await api('admin/accounts')) {
    const r = el('div', null, 'item');
    r.append(el('strong', u.name + ' · ' + (u.role === 'admin' ? '管理员' : u.enabled ? '成员' : '已停用')));
    if (u.role !== 'admin') {
      r.append(
        button(u.enabled ? '停用' : '启用', async () => {
          if (confirm('确认更改 ' + u.name + ' 的状态并撤销旧连接？')) {
            await api('admin/accounts/' + u.id, { operation: u.enabled ? 'disable' : 'enable' });
            render();
          }
        })
      );
      const reset = el('details');
      reset.append(el('summary', '重置此成员密码'));
      form(reset, [['password', '新的临时密码', 'password']], '重置并撤销会话', async (data) => {
        await api('admin/accounts/' + u.id, { operation: 'reset', ...data });
        render();
        notice('临时密码已重置。');
      });
      r.append(reset);
    }
    d.append(r);
  }
  const a = card(root, '最近管理记录');
  for (const e of await api('admin/audit'))
    a.append(
      el('p', new Date(e.at).toLocaleString() + ' · ' + e.actor + ' · ' + e.action + ' · ' + e.target)
    );
}
function deployments(root) {
  const box = card(root, '部署操作');
  const deploy = el('button', '一键部署', 'nv-button');
  deploy.type = 'button';
  deploy.dataset.variant = 'primary';
  deploy.disabled = true;
  const state = el('p', '正在读取部署状态…');
  state.setAttribute('role', 'status');
  box.append(deploy, state);
  const recent = card(root, '最近部署');
  const record = el('p');
  recent.append(record);
  const labels = {
    queued: '等待服务器执行',
    pulling: '正在拉取更新',
    updating: '正在更新服务并检查就绪状态',
    completed: '部署完成',
    source_failed: '拉取更新失败，请联系运维人员。',
    failed: '部署失败，请联系运维人员检查服务。',
    unknown: '部署操作中断，结果待核对。'
  };
  const key = 'navi.team.deploy-request.' + me.name;
  let pending = JSON.parse(sessionStorage.getItem(key) || 'null');
  let data = null, submitting = false;
  const forget = () => {
    pending = null;
    sessionStorage.removeItem(key);
  };
  function paint(message) {
    const job = data?.job, running = ['queued', 'pulling', 'updating'].includes(job?.status);
    deploy.disabled = submitting || !data?.enabled || running;
    deploy.textContent = pending ? '核对部署请求' : '一键部署';
    state.textContent = message || (!data ? '正在读取部署状态…' :
      running && job.status !== 'queued' ? labels[job.status] :
      !data.enabled ? '部署服务当前不可用，请联系运维人员。' :
      running ? labels[job.status] :
      job?.status === 'unknown' ? '请联系运维人员核对上一次部署。' :
      '部署期间服务可能短暂中断。');
    record.textContent = job
      ? new Date(job.startedAt).toLocaleString() + ' · ' + labels[job.status]
      : '暂无部署记录。';
  }
  async function refresh(duringSubmit = false) {
    const next = await api('admin/deployments');
    if (!root.isConnected || (submitting && !duringSubmit)) return;
    data = next;
    if (pending && (data.job?.id === pending.id || (data.job?.id ?? null) !== pending.previousId)) forget();
    paint();
  }
  deploy.onclick = async () => {
    if (deploy.disabled) return;
    pending ??= { id: crypto.randomUUID(), previousId: data.job?.id ?? null };
    sessionStorage.setItem(key, JSON.stringify(pending));
    submitting = true;
    paint('正在提交部署…');
    try {
      await api('admin/deployments/jobs', pending);
      await refresh(true);
    } catch (error) {
      if (error.status >= 400 && error.status < 500) forget();
      submitting = false;
      if (root.isConnected) paint(pending ? '提交结果待确认，可核对同一次部署。' : error.message);
      return;
    }
    submitting = false;
    if (root.isConnected) paint();
  };
  async function poll() {
    try {
      if (!submitting) await refresh();
    } catch {
      if (root.isConnected) {
        data = null;
        paint('暂时无法连接，正在重试。');
      }
    }
    if (root.isConnected) timer = setTimeout(poll, 2000);
  }
  void poll();
}
function render() {
  clearTimeout(timer);
  notice('');
  nav.replaceChildren();
  page.replaceChildren();
  $('who').textContent = me ? me.name : '';
  const root = el('div');
  page.append(root);
  if (!me) {
    authPage(root);
    return;
  }
  const items = me.mustChange
    ? []
    : [
        ['chat', '我的对话', chats],
        ['connections', '我的连接', connections],
        ['tasks', '目录任务', tasks],
        ['files', '任务文件', (r) => filesPage(r, { api, button, el, card, form, onAction, render, notice })],
        ...(me.role === 'admin'
          ? [
              ['accounts', '成员管理', accounts],
              ['deploy', '部署管理', deployments]
            ]
          : [])
      ];
  items.push(['password', '修改密码', passwordPage]);
  const current = items.find((x) => x[0] === view) || items[0];
  for (const [key, title] of items)
    nav.append(
      button(
        title,
        () => {
          view = key;
          render();
        },
        key === current[0]
      )
    );
  nav.append(
    button('退出', async () => {
      await api('logout', {});
      me = null;
      chatId = null;
      render();
    })
  );
  Promise.resolve(current[2](root)).catch((e) => {
    if (root.isConnected) notice(e.message);
  });
}
async function load() {
  try {
    me = await api('me');
  } catch {
    me = null;
  }
  view = location.hash === '#connections' ? 'connections' : 'chat';
  render();
}
load();
