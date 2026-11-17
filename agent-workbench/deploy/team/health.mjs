// Send the same Host as the reverse proxy even when the public origin uses HTTPS.
import { get } from 'node:http';
const port = Number(process.env.NAVI_TEAM_PORT || 17890);
const host = new URL(process.env.NAVI_TEAM_ORIGIN || 'http://127.0.0.1:' + port).host;
const request = get({ hostname: '127.0.0.1', port, path: '/healthz', headers: { host }, timeout: 2500 }, res => {
  res.resume();
  process.exitCode = res.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
