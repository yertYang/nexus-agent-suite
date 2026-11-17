import { isObject } from './net.mjs';
import { browserActionNames, browserUrl, roles } from '../examples/browser-lab/browser-actions.mjs';
const marker = 'NEXUS_BROWSER_REPORT=';
const observationMarker = 'NEXUS_BROWSER_OBSERVATION=';
const actions = new Set([...browserActionNames,'setup']);
const observationRoles = new Set(roles);
const statuses = new Set(['passed','failed']);
export function parseBrowserReport(result, runnerReport = false) {
  const row = result?.structuredContent;
  if (!isObject(row) || typeof row.stdout !== 'string') return null;
  const line = row.stdout.split(/\r?\n/).findLast(value => value.startsWith(marker));
  if (!line || line.length > 36_000) return null;
  let data;
  try { data = JSON.parse(line.slice(marker.length)); } catch { return null; }
  if (!isObject(data) || data.version !== 1 || typeof data.name !== 'string' || data.name.length > 100 ||
      !statuses.has(data.status) || !Number.isFinite(data.durationMs) || data.durationMs < 0 ||
      !Array.isArray(data.steps) || !data.steps.length || data.steps.length > 15 || (!runnerReport && (data.status === 'passed') !== (row.exitCode === 0)) || (runnerReport && row.exitCode !== 0)) return null;
  if (data.steps.some(step => !isObject(step) || !actions.has(step.action) || !statuses.has(step.status) ||
      !Number.isFinite(step.durationMs) || step.durationMs < 0 ||
      (step.error !== undefined && typeof step.error !== 'string'))) return null;
  if ((data.status === 'failed') !== data.steps.some(step=>step.status==='failed')) return null;
  let url = '';
  if (data.url) {
    try {
      const safe = new URL(data.url);
      if (!['http:','https:'].includes(safe.protocol) || safe.username || safe.password) return null;
      safe.search = ''; safe.hash = ''; url = safe.href;
    } catch { return null; }
  }
  let image = null;
  const encoded = data.screenshot?.base64;
  if (data.screenshot?.mime === 'image/jpeg' && typeof encoded === 'string' &&
      encoded.length <= 28_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    const bytes = Buffer.from(encoded,'base64');
    if (bytes.length <= 21_000 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) image = bytes;
  }
  const report = {
    version:1,name:data.name,status:data.status,durationMs:data.durationMs,url,
    ...(typeof data.screenshotNote==='string' ? {screenshotNote:data.screenshotNote.slice(0,170)} : {}),
    steps:data.steps.map(({action,status,durationMs,error}) => ({action,status,durationMs,
      ...(error !== undefined ? {error:error.slice(0, 200)} : {})}))
  };
  return { report, image, row };
}
export function parseBrowserObservation(result) {
  const row=result?.structuredContent;
  if (!isObject(row)||row.exitCode!==0||typeof row.stdout!=='string') return null;
  const line=row.stdout.split(/\r?\n/).findLast(value=>value.startsWith(observationMarker));
  if (!line||Buffer.byteLength(line)>20_000) return null;
  let data;
  try { data=JSON.parse(line.slice(observationMarker.length)); } catch { return null; }
  if (!isObject(data)||data.version!==1) return null;
  if (data.status==='failed'&&typeof data.error==='string') return {status:'failed',error:data.error.slice(0,200)};
  if (data.status!=='observed'||typeof data.title!=='string'||typeof data.text!=='string'||
      !Array.isArray(data.controls)||data.controls.length>18) return null;
  let url;
  try {url=browserUrl(data.url);url.search='';url.hash='';} catch {return null;}
  const controls=[];
  for (const item of data.controls) {
    if (!isObject(item)||!observationRoles.has(item.role)) return null;
    controls.push({role:item.role,name:String(item.name??'').slice(0,90),label:String(item.label??'').slice(0,90),
      testId:String(item.testId??'').slice(0,60)});
  }
  return {status:'observed',title:data.title.slice(0,130),text:data.text.slice(0,1400),url:url.href,controls};
}
export function withoutReportLine(value) {
  return String(value ?? '').split(/\r?\n/).filter(l => !l.startsWith(marker)&&!l.startsWith(observationMarker)).join('\n');
}
