import { randomUUID } from 'node:crypto';
import { fail, label } from './validation.mjs';
const MAX = 2 * 1024 * 1024,
  QUOTA = 64 * 1024 * 1024;
export function createFileTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,bytes BLOB NOT NULL,version INTEGER NOT NULL,changed INTEGER NOT NULL,editor TEXT NOT NULL REFERENCES users(id),sourceTask TEXT REFERENCES tasks(id));
 CREATE TABLE IF NOT EXISTS file_grants(file TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,uid TEXT NOT NULL REFERENCES users(id),access TEXT NOT NULL CHECK(access IN ('read','edit')),PRIMARY KEY(file,uid));CREATE INDEX IF NOT EXISTS files_owner ON files(owner);CREATE INDEX IF NOT EXISTS grants_user ON file_grants(uid);`);
}
function filename(v) {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.trim() === '.' ||
    v.trim() === '..' ||
    /[\\/:\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v) ||
    Buffer.byteLength(v) > 180
  )
    fail('请使用普通文件名（不含目录，最多 180 字节）');
  return v.trim().normalize('NFC');
}
const columns = `f.id,f.name,f.version,length(f.bytes) size,f.changed,u.name owner,e.name editor,CASE WHEN f.owner=? THEN 'owner' ELSE g.access END access`;
const joins = ` FROM files f JOIN users u ON u.id=f.owner JOIN users e ON e.id=f.editor LEFT JOIN file_grants g ON g.file=f.id AND g.uid=? WHERE (f.owner=? OR g.uid IS NOT NULL)`;
export function listFiles(db, s) {
  return db.all('SELECT ' + columns + joins + ' ORDER BY f.changed DESC', s.uid, s.uid, s.uid);
}
function entry(db, s, id) {
  const f = db.one('SELECT ' + columns + joins + ' AND f.id=?', s.uid, s.uid, s.uid, id);
  if (!f) fail('未找到文件或权限已撤销', 404);
  return f;
}
function quota(db, owner, added, creating) {
  const q = db.one('SELECT count(*) n,coalesce(sum(length(bytes)),0) size FROM files WHERE owner=?', owner);
  if (q.size + added > QUOTA || (creating && q.n >= 300))
    fail('文件所有者空间已满（64 MiB 或 300 个文件）', 409);
}
export function putFile(db, s, id, name, version, bytes, sourceTask = null) {
  db.guard(s);
  if (bytes.length > MAX) fail('单个文件最多 2 MiB', 413);
  return db.tx(() => {
    const now = Date.now();
    if (!id) {
      name = filename(name);
      quota(db, s.uid, bytes.length, true);
      id = randomUUID();
      db.run('INSERT INTO files VALUES(?,?,?,?,1,?,?,?)', id, s.uid, name, bytes, now, s.uid, sourceTask);
    } else {
      const f = entry(db, s, id);
      if (f.access === 'read') fail('该文件只读', 403);
      if (version !== f.version) fail('文件版本已变化，请重新下载并合并修改', 409);
      const owner = db.one('SELECT owner FROM files WHERE id=?', id).owner;
      quota(db, owner, bytes.length - f.size, false);
      db.run(
        'UPDATE files SET bytes=?,version=version+1,editor=?,changed=? WHERE id=?',
        bytes,
        s.uid,
        now,
        id
      );
    }
    db.log(s.uid, version ? 'file.update' : 'file.create', id);
    return entry(db, s, id);
  });
}
export function fileBytes(db, s, id) {
  const f = entry(db, s, id);
  return { ...f, bytes: db.one('SELECT bytes FROM files WHERE id=?', id).bytes };
}
export function createFromTask(db, s, body) {
  const t = db.one(
    "SELECT id,result FROM tasks WHERE uid=? AND id=? AND status='completed'",
    s.uid,
    body.task ?? ''
  );
  if (!t) fail('未找到本人已完成的任务', 404);
  return putFile(db, s, null, body.name, null, Buffer.from(t.result), t.id);
}
export function grants(db, s, id) {
  if (entry(db, s, id).access !== 'owner') fail('仅文件所有者可管理共享', 403);
  return db.all(
    'SELECT u.name,g.access FROM file_grants g JOIN users u ON u.id=g.uid WHERE file=? ORDER BY u.name',
    id
  );
}
export function share(db, s, id, b) {
  return db.tx(() => {
    if (entry(db, s, id).access !== 'owner') fail('仅文件所有者可管理共享', 403);
    const r = db.one('SELECT id,enabled FROM users WHERE name=?', label(b.name, 48).toLowerCase());
    if (!r || r.id === s.uid || (!r.enabled && b.access !== 'remove')) fail('请输入其他可用成员的用户名');
    if (b.access === 'remove') db.run('DELETE FROM file_grants WHERE file=? AND uid=?', id, r.id);
    else if (['read', 'edit'].includes(b.access))
      db.run(
        'INSERT INTO file_grants VALUES(?,?,?) ON CONFLICT(file,uid) DO UPDATE SET access=excluded.access',
        id,
        r.id,
        b.access
      );
    else fail('请选择只读或可编辑权限');
    db.log(s.uid, 'file.share.' + b.access, id + ':' + r.id);
    return grants(db, s, id);
  });
}
export function deleteFile(db, s, id, version) {
  const f = entry(db, s, id);
  if (f.access !== 'owner') fail('仅所有者可以删除', 403);
  if (f.version !== version) fail('文件版本已变化，请刷新', 409);
  db.run('DELETE FROM files WHERE id=?', id);
  db.log(s.uid, 'file.delete', id);
}
export async function readUpload(req) {
  if (Number(req.headers.get('content-length')) > MAX) fail('单个文件最多 2 MiB', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX) fail('单个文件最多 2 MiB', 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function taskContent(db, s, b) {
  if (b.action !== 'create') fail('任务文件只可用于新建文件');
  const f = fileBytes(db, s, b.fileId);
  if (f.version !== b.fileVersion) fail('共享文件已有新版本，请刷新后选择', 409);
  if (f.size > 48000) fail('创建任务只支持最多 12000 字符的 UTF-8 文本');
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(f.bytes);
  } catch {
    fail('此文件不是 UTF-8 文本');
  }
  if (content.includes('\x00') || content.length > 12000) fail('仅支持最多 12000 字符的文本');
  return content;
}
