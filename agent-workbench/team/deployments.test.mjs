import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamDeployments } from './deployments.mjs';
import { createTeamSite } from './site.mjs';
import { TeamStore } from './store.mjs';

async function mailbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'navi-team-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'requests'));
  await mkdir(join(directory, 'status'));
  await writeFile(join(directory, 'status', 'worker'), '');
  return directory;
}

test('deployment receipts survive a restart and concurrent submissions stay single-flight', async t => {
  const directory = await mailbox(t);
  const store = new TeamDeployments(directory);
  const first = { id: randomUUID(), previousId: null };
  const second = { id: randomUUID(), previousId: null };
  const [accepted, rejected] = await Promise.allSettled([store.start(first), store.start(second)]);
  assert.deepEqual(accepted.value, { id: first.id, created: true });
  assert.equal(rejected.reason.status, 409);

  const restarted = new TeamDeployments(directory);
  assert.equal((await restarted.read()).job.status, 'queued');
  assert.deepEqual(await restarted.start(first), { id: first.id, created: false });
  await writeFile(join(directory, 'status', 'result'), `${first.id} updating\n`);
  await assert.rejects(restarted.start({ ...second, previousId: first.id }), { status: 409 });
  await writeFile(join(directory, 'status', 'result'), `${first.id} completed\n`);
  assert.equal((await restarted.read()).job.status, 'completed');
  assert.equal((await restarted.start({ ...second, previousId: first.id })).created, true);
  await assert.rejects(restarted.start(first), { status: 409 });
  const past = new Date(Date.now() - 60_000);
  await utimes(join(directory, 'status', 'worker'), past, past);
  assert.deepEqual(await restarted.start({ ...second, previousId: first.id }), { id: second.id, created: false });
  assert.equal((await restarted.read()).enabled, false);
  assert.equal((await restarted.read()).reason, 'offline');
  assert.deepEqual(await new TeamDeployments().read(), { enabled: false, reason: 'unconfigured', job: null });
});

test('team deployment routes expose only receipts and require same-origin administrator access', async t => {
  const directory = await mailbox(t);
  const deployments = new TeamDeployments(directory);
  const db = new TeamStore(':memory:');
  t.after(() => db.close());
  const admin = await db.add('fixture-admin', 'synthetic test passphrase');
  const session = db.issue(admin.id, 'web', 'fixture', 60_000);
  const member = await db.add('fixture-member', 'synthetic test passphrase', db.identify(session.token, 'web'));
  db.run('UPDATE users SET mustChange=0 WHERE id=?', member.id);
  const memberSession = db.issue(member.id, 'web', 'fixture', 60_000);
  const origin = 'https://team.example.invalid';
  const route = createTeamSite({ db, origin, deployments });
  const api = (path, { body, token = session.token, source = origin } = {}) => route(new Request(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { cookie: '__Host-navi_team=' + token, origin: source, 'x-navi-web': '1', 'content-type': 'application/json' },
    body: body && JSON.stringify(body)
  }));
  const path = '/api/admin/deployments';
  const id = randomUUID();
  const body = { id, previousId: null, config: { sshHost: 'fixture-only.example.invalid' } };
  assert.equal((await api(path, { token: '' })).status, 401);
  assert.equal((await api(path, { token: memberSession.token })).status, 403);
  assert.equal((await api(path + '/jobs', { body, token: memberSession.token })).status, 403);
  assert.equal((await api(path + '/jobs', { body, source: 'https://other.example.invalid' })).status, 403);
  assert.equal((await api(path + '/config', { body })).status, 404);
  assert.deepEqual(await (await api(path)).json(), { enabled: true, job: null });

  const accepted = await api(path + '/jobs', { body });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { id });
  assert.equal(await readFile(join(directory, 'requests', 'current'), 'utf8'), id);
  assert.equal((await api(path + '/jobs', { body })).status, 202);
  assert.equal(db.one("SELECT count(*) AS total FROM audit WHERE action='deployment.start'").total, 1);
  const result = await (await api(path)).json();
  assert.deepEqual(result, { enabled: true, job: { id, status: 'queued', startedAt: result.job.startedAt } });
});
