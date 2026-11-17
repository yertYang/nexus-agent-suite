import { createHash } from 'node:crypto';
import { readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = fileURLToPath(new URL('../patches/nexus-office/', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const targetName = 'apps/runner/src/filesystem/office-text.ts';
const patch = resolve(directory,'01-office-read.patch');
const readLock = async () => JSON.parse(await readFile(resolve(directory, 'LOCK.json'), 'utf8'));
const readTarget = nexusSource => readFile(resolve(nexusSource,targetName)).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

function gitApply(nexusSource, args) {
  const out = spawnSync('git',['apply',...args,patch],{cwd:nexusSource,encoding:'utf8'});
  if (out.error) throw out.error;
  return out;
}

export async function hasCurrentOfficePatch(nexusSource) {
  const existing = await readTarget(nexusSource);
  if (!existing) return false;
  const lock = await readLock();
  return sha256(existing) === lock.sha256['office-text.ts'] &&
    sha256(await readFile(patch)) === lock.sha256['01-office-read.patch'] &&
    gitApply(nexusSource,['--reverse','--check']).status === 0;
}

export async function applyOfficePatch(nexusSource, revision) {
  const lock = await readLock();
  if (lock.nexusRevision !== revision) throw new Error('Office 适配不支持当前 Nexus 版本。');
  for (const name of ['01-office-read.patch','office-text.ts']) {
    if (sha256(await readFile(resolve(directory,name))) !== lock.sha256[name]) throw new Error('Office 适配文件校验失败：'+name);
  }
  const target = resolve(nexusSource,targetName);
  const existing = await readTarget(nexusSource);
  if (existing && sha256(existing) !== lock.sha256['office-text.ts']) throw new Error('本地 Nexus Office 适配源码已被修改。');
  const git = args => gitApply(nexusSource,args);
  if (git(['--reverse','--check']).status !== 0) {
    const check = git(['--check']);
    if (check.status !== 0) throw new Error('Office 适配与锁定 Nexus 不兼容：'+check.stderr.trim());
    const result = git([]);
    if (result.status !== 0) throw new Error('无法应用 Office 适配：'+result.stderr.trim());
  }
  if (!existing) await copyFile(resolve(directory,'office-text.ts'),target);
}
