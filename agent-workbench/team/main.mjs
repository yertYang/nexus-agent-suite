import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { resolve, join } from 'node:path';
import { chmod, readFile, stat } from 'node:fs/promises';
import { RUNTIME, privateDir } from '../scripts/lib.mjs';
import { Cpr, cprBaseUrl } from '../src/cpr.mjs';
import { DeploymentManager } from '../src/deployments.mjs';
import { TeamStore } from './store.mjs';
import { createTeamSite, teamOrigin } from './site.mjs';
import { hiddenInput } from './cli-input.mjs';
async function main() {
  process.umask(0o077);
  const directory = resolve(process.env.NAVI_TEAM_DATA || join(RUNTIME, 'team'));
  await privateDir(directory);
  const file = join(directory, 'team.sqlite'),
    db = new TeamStore(file);
  await chmod(file, 0o600);
  if (process.argv[2] === 'init') {
    try {
      await db.add(
        process.argv[3] || 'admin',
        await hiddenInput('设置初始管理员密码（至少 12 个字符，不回显）：')
      );
      console.log('管理员已初始化。');
    } finally {
      db.close();
    }
    return;
  }
  if (!db.one('SELECT id FROM users LIMIT 1'))
    throw Error('请先运行 npm run team:init -- admin 初始化管理员。');
  const port = Number(process.env.NAVI_TEAM_PORT || 17890);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('团队服务端口无效');
  const origin = teamOrigin(process.env.NAVI_TEAM_ORIGIN || 'http://127.0.0.1:' + port);
  let model = null;
  const modelId = process.env.NAVI_TEAM_MODEL,
    idFile = process.env.NAVI_TEAM_KEY_FILE,
    base = process.env.NAVI_TEAM_API_URL;
  if (modelId || idFile || base) {
    if (!modelId || !idFile || !base) throw Error('请同时配置团队模型 ID、API 地址和 Key 文件');
    const st = await stat(idFile);
    if (!st.isFile() || st.mode & 0o077 || st.size > 4096) throw Error('模型 Key 需要独立的 0600 私有文件');
    const key = (await readFile(idFile, 'utf8')).trim();
    if (!key) throw Error('模型 Key 文件为空');
    model = new Cpr({ url: cprBaseUrl(base), key });
  }
  const deployments = new DeploymentManager({ file: join(directory, 'deployments.json') });
  const route = createTeamSite({ db, origin, modelId, model, deployments });
  const expected = new URL(origin).host;
  const server = createServer(
    { requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 12000 },
    async (req, res) => {
      try {
        if (req.headers.host !== expected || !/^\/(?!\/)/.test(req.url) || req.url.includes('\\')) {
          res.writeHead(403).end();
          return;
        }
        const request = new Request(origin + req.url, {
          method: req.method,
          headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: 'half' })
        });
        const reply = await route(request);
        res.writeHead(reply.status, Object.fromEntries(reply.headers));
        res.end(Buffer.from(await reply.arrayBuffer()));
      } catch {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      }
    }
  );
  server.once('close', () => {
    deployments.stop();
    db.close();
  });
  server.on('error', () => {
    console.error('团队网站监听失败，请检查端口和系统权限。');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () =>
    console.log('Navi 团队网站：' + origin + '（本机监听 127.0.0.1:' + port + '）')
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
