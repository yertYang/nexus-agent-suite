import { createFileTables } from './files.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail, label } from './validation.mjs';
export { fail, label } from './validation.mjs';
export const secret = () => randomBytes(32).toString('base64url');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const scrypt = promisify(derive),
  hour = 3600000;
function username(s) {
  if (typeof s !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,47}$/.test(s))
    fail('用户名需为 3–48 位字母、数字、点、短横线或下划线');
  return s.toLowerCase();
}
function password(s) {
  if (typeof s !== 'string' || s.length < 12 || Buffer.byteLength(s) > 512)
    fail('密码至少 12 个字符，最多 512 字节');
  return s;
}
const publicColumns = 'id,name,role,enabled,mustChange';
export class TeamStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.hashing = 0;
    this.attempts = new Map();
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,mustChange INTEGER NOT NULL,salt TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,label TEXT NOT NULL,id TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL,project TEXT,seen INTEGER DEFAULT 0,canCreate INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS codes(digest TEXT PRIMARY KEY,uid TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,uid TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,history TEXT NOT NULL,changed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,uid TEXT NOT NULL REFERENCES users(id),device TEXT NOT NULL,action TEXT NOT NULL,path TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,changed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(uid);CREATE INDEX IF NOT EXISTS chats_owner ON chats(uid,changed);CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(uid,device,status);`);
    createFileTables(this.db);
  }
  one(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  log(actor, action, target) {
    this.run('INSERT INTO audit(actor,action,target,at) VALUES(?,?,?,?)', actor, action, target, Date.now());
  }
  async key(value, salt) {
    if (this.hashing >= 4) fail('登录繁忙，请稍后重试', 429);
    this.hashing++;
    try {
      return (await scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString(
        'hex'
      );
    } finally {
      this.hashing--;
    }
  }
  async add(name, pw, adminSession = null) {
    name = username(name);
    const salt = secret(),
      digest = await this.key(password(pw), salt),
      id = randomUUID();
    return this.tx(() => {
      if (adminSession) this.guard(adminSession, 'admin');
      else if (this.one('SELECT id FROM users LIMIT 1')) fail('管理员已初始化', 409);
      if (this.one('SELECT id FROM users WHERE name=?', name)) fail('用户名已存在', 409);
      this.run(
        'INSERT INTO users(id,name,role,mustChange,salt,digest) VALUES(?,?,?,?,?,?)',
        id,
        name,
        adminSession ? 'member' : 'admin',
        adminSession ? 1 : 0,
        salt,
        digest
      );
      this.log(adminSession?.uid ?? id, 'account.create', id);
      return { id, name };
    });
  }
  throttle(key) {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (v.until <= now) this.attempts.delete(k);
    if (!this.attempts.has(key) && this.attempts.size >= 3000) fail('登录尝试过多', 429);
    const entry = this.attempts.get(key) ?? { count: 0, until: now + 600000 };
    this.attempts.set(key, entry);
    if (++entry.count > 12) fail('登录尝试过多，请稍后重试', 429);
  }
  async login(name, pw) {
    name = username(name);
    this.throttle(name);
    if (typeof pw !== 'string' || Buffer.byteLength(pw) > 512) fail('账号或密码错误', 401);
    const u = this.one('SELECT * FROM users WHERE name=?', name);
    const key = await this.key(pw, u?.salt ?? 'unknown-user-dummy-salt');
    if (
      !u ||
      !timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(u.digest, 'hex')) ||
      !this.one('SELECT id FROM users WHERE id=? AND enabled=1 AND digest=?', u.id, u.digest)
    )
      fail('账号或密码错误', 401);
    this.attempts.delete(name);
    return this.issue(u.id, 'web', '网站', 12 * hour);
  }
  issue(uid, kind, title, lifetime, project = null, canCreate = false) {
    const token = secret(),
      id = randomUUID();
    this.run('DELETE FROM sessions WHERE expires<=?', Date.now());
    this.run(
      'INSERT INTO sessions(token,uid,kind,label,id,expires,project,canCreate) VALUES(?,?,?,?,?,?,?,?)',
      hash(token),
      uid,
      kind,
      title,
      id,
      Date.now() + lifetime,
      project,
      Number(canCreate)
    );
    return { token, id };
  }
  identify(token, kind) {
    const h = typeof token === 'string' && /^[\w-]{43}$/.test(token) ? hash(token) : '';
    return this.guard({ h, kind }, 'login');
  }
  guard(s, level = 'active') {
    const row = this.one(
      `SELECT s.token h,s.uid,s.id,s.kind,s.project,s.canCreate,u.name,u.role,u.mustChange FROM sessions s JOIN users u ON u.id=s.uid WHERE token=? AND kind=? AND expires>? AND enabled=1`,
      s.h,
      s.kind,
      Date.now()
    );
    if (!row) fail('登录或连接已失效', 401);
    if (level !== 'login' && row.mustChange) fail('请先设置自己的新密码', 403);
    if (level === 'admin' && (row.role !== 'admin' || row.kind !== 'web')) fail('仅网站管理员可操作', 403);
    return row;
  }
  revoke(uid) {
    this.run('DELETE FROM sessions WHERE uid=?', uid);
    this.run('DELETE FROM codes WHERE uid=?', uid);
    this.run(
      "UPDATE tasks SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'unknown' END,changed=? WHERE uid=? AND status IN ('queued','claimed')",
      Date.now(),
      uid
    );
  }
  async change(s, old, next) {
    this.throttle('change:' + s.uid);
    const user = this.one('SELECT * FROM users WHERE id=?', s.uid);
    if (typeof old !== 'string' || Buffer.byteLength(old) > 512 || old === next)
      fail('请输入当前密码和不同的新密码');
    if ((await this.key(old, user.salt)) !== user.digest) fail('当前密码不正确', 403);
    const salt = secret(),
      digest = await this.key(password(next), salt);
    this.tx(() => {
      this.guard(s, 'login');
      this.run('UPDATE users SET digest=?,salt=?,mustChange=0 WHERE id=?', digest, salt, s.uid);
      this.revoke(s.uid);
      this.log(s.uid, 'password.change', s.uid);
    });
  }
  async manage(s, id, operation, pw) {
    this.guard(s, 'admin');
    const u = this.one('SELECT * FROM users WHERE id=?', id);
    if (!u) fail('账号不存在', 404);
    if (u.role === 'admin') fail('此处仅管理成员账号', 403);
    const salt = operation === 'reset' ? secret() : null,
      digest = salt ? await this.key(password(pw), salt) : null;
    this.tx(() => {
      this.guard(s, 'admin');
      if (salt) this.run('UPDATE users SET digest=?,salt=?,mustChange=1 WHERE id=?', digest, salt, id);
      else if (['enable', 'disable'].includes(operation))
        this.run('UPDATE users SET enabled=? WHERE id=?', Number(operation === 'enable'), id);
      else fail('不支持的账号操作');
      this.revoke(id);
      this.log(s.uid, 'account.' + operation, id);
    });
  }
  accounts(s) {
    this.guard(s, 'admin');
    return this.all(`SELECT ${publicColumns} FROM users ORDER BY name`);
  }
  code(s, kind) {
    if (!['plugin', 'device'].includes(kind)) fail('连接类型错误');
    const code = secret();
    this.run('DELETE FROM codes WHERE (uid=? AND kind=?) OR expires<=?', s.uid, kind, Date.now());
    this.run('INSERT INTO codes VALUES(?,?,?,?)', hash(code), s.uid, kind, Date.now() + 120000);
    return code;
  }
  redeem(kind, body) {
    if (!['plugin', 'device'].includes(kind) || typeof body.code !== 'string' || body.code.length !== 43)
      fail('配对码无效或过期', 403);
    return this.tx(() => {
      const d = hash(body.code),
        record = this.one(
          'SELECT c.uid,u.name FROM codes c JOIN users u ON u.id=c.uid WHERE c.digest=? AND c.kind=? AND c.expires>? AND u.enabled=1 AND u.mustChange=0',
          d,
          kind,
          Date.now()
        );
      if (!record) fail('配对码无效或过期', 403);
      const title = label(body.label),
        project = kind === 'device' ? label(body.project) : null;
      this.run('DELETE FROM codes WHERE digest=?', d);
      const grant = this.issue(
        record.uid,
        kind,
        title,
        7 * 24 * hour,
        project,
        kind === 'device' && body.canCreate === true
      );
      this.log(record.uid, 'connect.' + kind, grant.id);
      return { ...grant, username: record.name };
    });
  }
  disconnect(s, id) {
    const row = this.one("SELECT id FROM sessions WHERE id=? AND uid=? AND kind!='web'", id, s.uid);
    if (!row) fail('未找到连接', 404);
    this.run('DELETE FROM sessions WHERE id=? AND uid=?', id, s.uid);
    this.run(
      "UPDATE tasks SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'unknown' END WHERE device=? AND uid=? AND status IN ('queued','claimed')",
      id,
      s.uid
    );
    this.log(s.uid, 'disconnect', id);
  }
  connections(s) {
    return this.all(
      "SELECT id,label,kind,expires,project,seen,canCreate FROM sessions WHERE uid=? AND kind!='web' AND expires>? ORDER BY label",
      s.uid,
      Date.now()
    );
  }
  close() {
    this.db.close();
  }
}
