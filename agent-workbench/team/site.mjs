import {
  listFiles,
  putFile,
  fileBytes,
  createFromTask,
  grants,
  share,
  deleteFile,
  readUpload,
  taskContent
} from './files.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError, readText } from '../src/net.mjs';
import { modelOutput, turnTimeContext } from '../src/cpr.mjs';
import { fail } from './store.mjs';
import { claim, result, queueTask, expireTasks } from './tasks.mjs';
const assets = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/team.js', ['public/team.js', 'application/javascript']],
  ['/files-ui.js', ['public/files-ui.js', 'application/javascript']],
  ['/team.css', ['public/team.css', 'text/css']],
  ['/ui/chevron-down.svg', ['../public/ui/chevron-down.svg', 'image/svg+xml']],
  ...['tokens', 'components'].map((n) => ['/ui/' + n + '.css', ['../public/ui/' + n + '.css', 'text/css']])
]);
export function teamOrigin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {}
  if (
    !u ||
    u.href !== u.origin + '/' ||
    !(u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1'))
  )
    fail('团队网站地址须为 HTTPS 根地址，本机开发可用 http://127.0.0.1:端口');
  return u.origin;
}
export function createTeamSite({ db, origin, model, modelId, deployments }) {
  origin = teamOrigin(origin);
  const secure = origin.startsWith('https:'),
    cookieName = secure ? '__Host-navi_team' : 'navi_team_local';
  const busy = new Set();
  const cookie = (value, age) =>
    `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  return async (req) => {
    const url = new URL(req.url),
      p = url.pathname,
      m = req.method,
      source = req.headers.get('origin');
    const hdr = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    };
    const json = (value, status = 200) => Response.json(value, { status, headers: hdr });
    try {
      if (url.origin !== origin || url.search) fail('站点地址不匹配', 403);
      if (m === 'GET' && p === '/healthz') {
        // A readable account database is required for this instance to serve requests.
        return db.one('SELECT 1 AS ready FROM users LIMIT 1') ? json({ ready: true }) : json({ ready: false }, 503);
      }
      if (m === 'GET' && assets.has(p)) {
        const [file, type] = assets.get(p);
        return new Response(await readFile(new URL(file, import.meta.url)), {
          headers: { ...hdr, 'content-type': type + '; charset=utf-8' }
        });
      }
      if (!p.startsWith('/api/')) fail('未找到页面', 404);
      const ext = source && /^chrome-extension:\/\/[a-p]{32}$/.test(source),
        client = p.startsWith('/api/client/');
      if (client) {
        if (req.headers.has('cookie') || (source && !ext)) fail('客户端来源错误', 403);
        if (ext) {
          Object.assign(hdr, {
            'access-control-allow-origin': source,
            vary: 'Origin',
            'access-control-allow-methods': 'GET, POST',
            'access-control-allow-headers': 'Authorization, Content-Type'
          });
          if (m === 'OPTIONS') return new Response(null, { status: 204, headers: hdr });
        }
      } else if (
        (source && source !== origin) ||
        (m !== 'GET' && (source !== origin || req.headers.get('x-navi-web') !== '1'))
      )
        fail('请通过团队网站操作', 403);
      const upload = m === 'POST' && /^\/api\/files\/(?:upload|[a-f0-9-]{36}\/replace)$/.test(p);
      let body = {};
      if (m === 'POST' && !upload) {
        if (req.headers.get('content-type')?.split(';')[0] !== 'application/json') fail('需要 JSON', 415);
        const text = await readText(req.body, 96000);
        try {
          body = JSON.parse(text);
        } catch {
          fail('无效 JSON');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('无效请求');
      }
      if (m === 'POST' && p === '/api/login') {
        const auth = await db.login(body.name, body.password);
        hdr['set-cookie'] = cookie(auth.token, 43200);
        return json({ ok: true });
      }
      if (m === 'POST' && p === '/api/client/redeem') {
        return json(db.redeem(body.kind, body));
      }
      const device = p.startsWith('/api/client/device/'),
        token = client
          ? req.headers.get('authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1]
          : req.headers
              .get('cookie')
              ?.split(/;\s*/)
              .find((v) => v.startsWith(cookieName + '='))
              ?.slice(cookieName.length + 1);
      const s = db.identify(token, client ? (device ? 'device' : 'plugin') : 'web');
      if (m === 'GET' && p === '/api/me')
        return json({ name: s.name, role: s.role, mustChange: !!s.mustChange, model: modelId || null });
      if (m === 'POST' && p === '/api/logout') {
        db.run('DELETE FROM sessions WHERE token=?', s.h);
        hdr['set-cookie'] = cookie('', 0);
        return json({});
      }
      if (m === 'POST' && p === '/api/password') {
        await db.change(s, body.old, body.next);
        hdr['set-cookie'] = cookie('', 0);
        return json({});
      }
      db.guard(s);
      if (p.startsWith('/api/admin/')) {
        db.guard(s, 'admin');
        if (p === '/api/admin/accounts' && m === 'GET') return json(db.accounts(s));
        if (p === '/api/admin/accounts' && m === 'POST')
          return json(await db.add(body.name, body.password, s), 201);
        const a = p.match(/^\/api\/admin\/accounts\/([\w-]+)$/);
        if (a && m === 'POST') {
          await db.manage(s, a[1], body.operation, body.password);
          return json({});
        }
        if (p === '/api/admin/audit' && m === 'GET')
          return json(
            db.all(
              'SELECT u.name actor,a.action,a.target,a.at FROM audit a JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 30'
            )
          );
        if (p.startsWith('/api/admin/deployments') && deployments) {
          if (p === '/api/admin/deployments' && m === 'GET') return json(await deployments.read());
          if (m === 'POST' && p === '/api/admin/deployments/config') {
            const v = await deployments.save(body.config, body.revision);
            db.log(s.uid, 'deployment.configure', v.revision);
            return json(v);
          }
          if (m === 'POST' && p === '/api/admin/deployments/jobs') {
            const job = await deployments.start(body);
            db.log(s.uid, 'deployment.' + job.action, job.id);
            return json(job, 202);
          }
        }
      }
      if (m === 'POST' && p === '/api/connections/code')
        return json({ code: db.code(s, body.kind), expiresIn: 120 });
      if (m === 'GET' && p === '/api/connections') return json(db.connections(s));
      if (m === 'POST' && p === '/api/connections/revoke') {
        db.disconnect(s, body.id ?? '');
        return json({});
      }
      if (m === 'POST' && (p === '/api/client/disconnect' || p === '/api/client/device/disconnect')) {
        db.disconnect(s, s.id);
        return json({});
      }
      if (device) {
        if (m === 'POST' && p === '/api/client/device/check') {
          expireTasks(db);
          if (
            !db.one(
              "SELECT id FROM tasks WHERE uid=? AND device=? AND id=? AND status='claimed'",
              s.uid,
              s.id,
              body.id ?? ''
            )
          )
            fail('任务已失效', 409);
          return json({ ok: true });
        }
        if (m === 'POST' && p === '/api/client/device/claim') return json(claim(db, s));
        if (m === 'POST' && p === '/api/client/device/result') return json(result(db, s, body));
        fail('未知设备操作', 404);
      }
      if (m === 'GET' && p === '/api/files') return json(listFiles(db, s));
      if (m === 'POST' && p === '/api/files/from-task') return json(createFromTask(db, s, body), 201);
      const fileRoute = p.match(/^\/api\/files\/([a-f0-9-]{36})\/(download|grants|delete|replace)$/);
      if (upload) {
        if (req.headers.get('content-type') !== 'application/octet-stream') fail('需要文件内容', 415);
        const bytes = await readUpload(req);
        let name;
        try {
          name = decodeURIComponent(req.headers.get('x-file-name') || '');
        } catch {
          fail('文件名无效');
        }
        return json(
          putFile(db, s, fileRoute?.[1], name, Number(req.headers.get('x-file-version')), bytes),
          fileRoute ? 200 : 201
        );
      }
      if (fileRoute) {
        const [, id, op] = fileRoute;
        if (m === 'GET' && op === 'download') {
          const f = fileBytes(db, s, id);
          return new Response(f.bytes, {
            headers: {
              ...hdr,
              'content-type': 'application/octet-stream',
              'content-disposition':
                "attachment; filename*=UTF-8''" +
                encodeURIComponent(f.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16)),
              'x-file-version': String(f.version)
            }
          });
        }
        if (op === 'grants' && m === 'GET') return json(grants(db, s, id));
        if (op === 'grants' && m === 'POST') return json(share(db, s, id, body));
        if (op === 'delete' && m === 'POST') {
          deleteFile(db, s, id, body.version);
          return json({});
        }
      }
      if (p === '/api/tasks' && m === 'GET') {
        expireTasks(db);
        return json(
          db.all(
            'SELECT id,action,path,status,result,changed FROM tasks WHERE uid=? ORDER BY changed DESC LIMIT 30',
            s.uid
          )
        );
      }
      if (p === '/api/tasks' && m === 'POST') {
        if (body.fileId !== undefined) body.content = taskContent(db, s, body);
        return json(queueTask(db, s, body), 202);
      }
      const route = client ? p.replace('/api/client/', '/api/') : p;
      if (route === '/api/chats' && m === 'GET')
        return json(
          db.all('SELECT id,title,changed FROM chats WHERE uid=? ORDER BY changed DESC LIMIT 100', s.uid)
        );
      const detail = route.match(/^\/api\/chats\/([\w-]+)$/);
      if (detail && m === 'GET') {
        const c = db.one('SELECT title,history FROM chats WHERE uid=? AND id=?', s.uid, detail[1]);
        if (!c) fail('未找到对话', 404);
        return json({
          title: c.title,
          messages: JSON.parse(c.history)
            .filter((x) => ['user', 'assistant'].includes(x.role))
            .map((x) => ({ role: x.role, text: x.text }))
        });
      }
      if (route === '/api/chats/send' && m === 'POST') {
        if (!model || !modelId) fail('团队网站尚未配置模型，请联系管理员', 503);
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 12000)
          fail('消息需为 1–12000 字符');
        if (busy.has(s.uid) || busy.size >= 12) fail('已有对话正在生成，请稍后再试', 429);
        const id = body.id ?? randomUUID();
        if (typeof id !== 'string') fail('对话编号无效');
        const c = db.one('SELECT history,title FROM chats WHERE uid=? AND id=?', s.uid, id);
        if (body.id != null && !c) fail('未找到对话', 404);
        const history = c ? JSON.parse(c.history) : [];
        if (history.length >= 100 || JSON.stringify(history).length > 180000)
          fail('对话已达上限，请新建对话', 409);
        busy.add(s.uid);
        try {
          const now = Date.now(),
            turn = randomUUID();
          history.push({ role: 'user', text: body.text, at: now });
          let reply;
          try {
            const r = modelOutput(
              await model.respond({
                model: modelId,
                input: history.flatMap((x) =>
                  x.role === 'user'
                    ? [turnTimeContext(x.at), { role: x.role, content: x.text }]
                    : [{ role: 'assistant', content: x.text }]
                ),
                tools: [],
                conversationId: id,
                turnId: turn
              })
            );
            if (r.calls.length || !r.text || r.text.length > 64000) throw Error();
            reply = r.text;
          } catch {
            fail('模型未完成，请检查服务器模型配置或稍后重试', 502);
          }
          db.guard(s);
          history.push({ role: 'assistant', text: reply });
          if (c)
            db.run(
              'UPDATE chats SET history=?,changed=? WHERE id=? AND uid=?',
              JSON.stringify(history),
              now,
              id,
              s.uid
            );
          else
            db.run(
              'INSERT INTO chats VALUES(?,?,?,?,?)',
              id,
              s.uid,
              body.text.trim().slice(0, 55),
              JSON.stringify(history),
              now
            );
          return json({ id, text: reply });
        } finally {
          busy.delete(s.uid);
        }
      }
      fail('未找到接口', 404);
    } catch (e) {
      return json(
        { error: e instanceof AppError ? e.message : '服务处理失败' },
        e instanceof AppError ? e.status : 500
      );
    }
  };
}
