import { randomUUID } from 'node:crypto';
import { fail } from './store.mjs';
export function taskInput(b, canCreate) {
  if (!['list', 'read', 'create'].includes(b.action) || (b.action === 'create' && !canCreate))
    fail('此连接未授权该操作', 403);
  const path = b.path;
  if (
    typeof path !== 'string' ||
    path.length > 500 ||
    !path ||
    /[:\\\x00-\x1f\x7f]/.test(path) ||
    (path === '.' ? b.action !== 'list' : path.split('/').some((p) => !p || p === '.' || p === '..'))
  )
    fail('请选择项目内的相对路径');
  const content = b.action === 'create' ? b.content : '';
  if (typeof content !== 'string' || content.length > 12000) fail('新文件内容超过限制');
  return { action: b.action, path, content };
}
export function expireTasks(db) {
  const now = Date.now();
  db.run("UPDATE tasks SET status='expired' WHERE status='queued' AND changed<?", now - 120000);
  db.run("UPDATE tasks SET status='unknown' WHERE status='claimed' AND changed<?", now - 300000);
}
export function queueTask(db, s, b) {
  expireTasks(db);
  const d = db.one(
    "SELECT * FROM sessions WHERE id=? AND kind='device' AND uid=? AND expires>?",
    b.device ?? '',
    s.uid,
    Date.now()
  );
  if (!d) fail('未找到设备', 404);
  if (d.seen < Date.now() - 30000) fail('设备离线，请先启动本机连接', 409);
  const t = taskInput(b, d.canCreate);
  if (db.one("SELECT id FROM tasks WHERE uid=? AND device=? AND status IN ('queued','claimed')", s.uid, d.id))
    fail('该设备正在处理任务', 409);
  const id = randomUUID();
  db.run(
    'INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)',
    id,
    s.uid,
    d.id,
    t.action,
    t.path,
    t.content,
    'queued',
    '',
    Date.now()
  );
  return { id };
}
export function claim(db, s) {
  return db.tx(() => {
    expireTasks(db);
    db.run('UPDATE sessions SET seen=? WHERE token=?', Date.now(), s.h);
    const t = db.one(
      "SELECT id,action,path,content FROM tasks WHERE uid=? AND device=? AND status='queued' ORDER BY changed LIMIT 1",
      s.uid,
      s.id
    );
    if (t) db.run("UPDATE tasks SET status='claimed',changed=? WHERE id=?", Date.now(), t.id);
    return { task: t ?? null };
  });
}
export function result(db, s, b) {
  expireTasks(db);
  if (
    !['completed', 'failed', 'denied', 'unknown'].includes(b.status) ||
    typeof b.result !== 'string' ||
    b.result.length > 16000
  )
    fail('任务结果格式无效');
  const r = db.run(
    "UPDATE tasks SET status=?,result=?,changed=? WHERE uid=? AND device=? AND id=? AND status='claimed'",
    b.status,
    b.result,
    Date.now(),
    s.uid,
    s.id,
    b.id ?? ''
  );
  if (!r.changes) fail('任务不属于此连接或已结束', 409);
  return {};
}
