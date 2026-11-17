// Team credentials belong only to trusted extension contexts in this browser session.
const $ = (id) => document.getElementById(id),
  key = 'navi.team.session';
let grant = null,
  current = '',
  revision = 0;
function originOf(value) {
  let u;
  try {
    u = new URL(value.trim());
  } catch {}
  if (
    !u ||
    u.href !== u.origin + '/' ||
    !(u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1'))
  )
    throw Error('请输入团队网站的 HTTPS 根地址。');
  return u.origin;
}
async function call(origin, path, body, token) {
  const r = await fetch(origin + '/api/client/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(110000),
    headers: {
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const v = await r.json();
  if (!r.ok) {
    if (r.status === 401 && grant?.token === token) await forget();
    throw Error(v.error || '团队网站请求失败');
  }
  return v;
}
const api = (p, b) => call(grant.origin, p, b, grant.token);
function state() {
  revision++;
  $('chat').hidden = !grant;
  $('connect').hidden = !!grant;
  $('account').textContent = grant ? grant.username + ' · ' + grant.origin : '';
  $('messages').replaceChildren();
  $('text').value = '';
  current = '';
}
async function forget() {
  await chrome.storage.session.remove(key);
  grant = null;
  state();
}
function wire(id, event, fn) {
  $(id).addEventListener(event, async (e) => {
    e.preventDefault();
    const b = e.submitter || e.currentTarget;
    if (b.disabled) return;
    b.disabled = true;
    $('status').textContent = '';
    try {
      await fn();
    } catch (e) {
      $('status').textContent = e.message;
    } finally {
      b.disabled = false;
    }
  });
}
async function list() {
  const own = grant;
  const rows = await api('chats');
  if (own !== grant) return;
  $('chats').replaceChildren(new Option('新对话', ''));
  for (const r of rows) $('chats').add(new Option(r.title, r.id));
  $('chats').value = current;
}
async function show() {
  const rev = ++revision;
  $('messages').replaceChildren();
  if (!current) return;
  const v = await api('chats/' + current);
  if (rev !== revision) return;
  for (const m of v.messages) {
    const name = document.createElement('strong'),
      text = document.createElement('pre');
    name.textContent = m.role === 'user' ? '你' : 'Navi';
    text.textContent = m.text;
    $('messages').append(name, text);
  }
}
wire('open', 'click', () => chrome.tabs.create({ url: originOf($('origin').value) + '/#connections' }));
wire('pair', 'submit', async () => {
  const origin = originOf($('origin').value),
    u = new URL(origin);
  if (!(await chrome.permissions.request({ origins: [u.protocol + '//' + u.hostname + '/*'] })))
    throw Error('未授予团队网站访问权限');
  const v = await call(origin, 'redeem', {
    kind: 'plugin',
    label: 'Navi Link',
    code: $('code').value.trim()
  });
  if (typeof v.token !== 'string' || !/^[\w-]{43}$/.test(v.token)) throw Error('网站未返回有效的连接');
  $('code').value = '';
  grant = { origin, token: v.token, username: v.username };
  await chrome.storage.session.set({ [key]: grant });
  state();
  await list();
});
wire('disconnect', 'click', async () => {
  await api('disconnect', {});
  await forget();
});
wire('chats', 'change', async () => {
  current = $('chats').value;
  await show();
});
wire('compose', 'submit', async () => {
  const text = $('text').value.trim(),
    own = grant;
  if (!text) return;
  $('chats').disabled = true;
  try {
    const v = await api('chats/send', { id: current || null, text });
    if (grant !== own) return;
    current = v.id;
    $('text').value = '';
    await list();
    await show();
  } finally {
    $('chats').disabled = false;
  }
});
try {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  grant = (await chrome.storage.session.get(key))[key] || null;
  state();
  if (grant) await list();
} catch (e) {
  $('status').textContent = e.message;
}
