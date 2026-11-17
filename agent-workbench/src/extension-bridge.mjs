import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from './net.mjs';

const editTools=['file_create','file_write','file_patch','fs_mkdir'].map(name=>'localbridge_'+name);
const lifetime=12*3600_000;
const maxRequests=256;
const bearer=/^Bearer (nvl_([A-Za-z0-9_-]{43}))$/;
const digest=token=>createHash('sha256').update(token).digest('hex');
const unauthorized=()=>new AppError('Navi Link 的聊天连接已失效，请重新配对。',401,'EXTENSION_BRIDGE_UNAUTHORIZED');
const readTools=Object.freeze(['project_info','directory_list','file_stat','file_read','fs_search','fs_grep','git_status','git_diff']
  .map(name=>'localbridge_'+name));

export function createBridgeGrants(now=Date.now) {
  const byHash=new Map();
  function assertActive(grant) {
    if (!grant || byHash.get(grant.hash)!==grant || grant.expiresAt<=now() || grant.signal.aborted) throw unauthorized();
  }
  return {
    issue(project,extensionOrigin,access='read',automation=false) {
      if (!['read','testing'].includes(access)) throw unauthorized();
      const permissions=typeof automation==='boolean' ? {browserAutomation:automation,fileOperations:automation} : automation;
      if (!permissions || typeof permissions!=='object' || Array.isArray(permissions) || Object.keys(permissions).some(key=>!['browserAutomation','fileOperations'].includes(key)) ||
          Object.values(permissions).some(value=>typeof value!=='boolean')) throw unauthorized();
      const browserAutomation=permissions.browserAutomation===true,fileOperations=permissions.fileOperations===true;
      automation=browserAutomation && fileOperations;
      const time=now();
      for (const [key,grant] of byHash) if (grant.expiresAt<=time) byHash.delete(key);
      if (byHash.size>=128) throw new AppError('聊天连接过多，请断开不用的扩展连接后再试。',429,'EXTENSION_BRIDGE_LIMIT');
      const token='nvl_'+randomBytes(32).toString('base64url'), hash=digest(token);
      const grantId=randomUUID(), expiresAt=time+lifetime;
      byHash.set(hash,{ hash,grantId,extensionOrigin,expiresAt,access,automation,browserAutomation,fileOperations,projectId:project.id,name:project.name,runnerId:project.runnerId,
        signal:AbortSignal.timeout(lifetime), requests:new Map() });
      return {token,grantId,expiresAt};
    },
    authorize(value,origin) {
      const match=typeof value==='string' ? value.match(bearer) : null;
      if (!match || Buffer.from(match[2],'base64url').toString('base64url')!==match[2]) throw unauthorized();
      const grant=byHash.get(digest(match[1]));
      assertActive(grant);
      if (grant.extensionOrigin!==origin) throw unauthorized();
      return grant;
    },
    assertActive,
    revoke(grant) { byHash.delete(grant.hash); },
    createRun(grant,requestId,body,create) {
      assertActive(grant);
      const fingerprint=digest(JSON.stringify([body.prompt,body.model,body.previousRunId ?? null,body.projectSelected ?? null]));
      const existing=grant.requests.get(requestId);
      if (existing) {
        if (existing.fingerprint!==fingerprint) throw new AppError('此请求编号已绑定另一条聊天消息。',409,'EXTENSION_REQUEST_CONFLICT');
        return existing.promise;
      }
      if (grant.requests.size>=maxRequests) {
        throw new AppError('此连接的聊天请求已达上限，请重新配对。',429,'EXTENSION_REQUEST_LIMIT');
      }
      const promise=Promise.resolve().then(()=>{
        assertActive(grant);
        return create();
      }).catch(error=>{
        grant.requests.delete(requestId);
        throw error;
      });
      grant.requests.set(requestId,{fingerprint,promise});
      return promise;
    },
    policy(grant) {
      return Object.freeze({
        projectId:grant.projectId, automation:grant.automation, browserAutomation:grant.browserAutomation, fileOperations:grant.fileOperations, allowedTools:grant.fileOperations ? [...readTools,...editTools] : readTools, confirmAll:true, testing:grant.access==='testing', signal:grant.signal,
        assertActive:()=>assertActive(grant),
        assertProject:project=>{
          if (project.id!==grant.projectId || project.runnerId!==grant.runnerId || project.name!==grant.name ||
            project.enabled!==true || !['read-only','read-write'].includes(project.accessMode)) {
            throw new AppError('配对项目已变更或不可用，请重新确认授权。',409,'EXTENSION_PROJECT_CHANGED');
          }
        }
      });
    }
  };
}

export function redactBridge(value,secrets,depth=0) {
  if (depth>40) return '[已截断]';
  if (typeof value==='string') {
    for (const secret of secrets) if (typeof secret==='string' && secret.length>=8) value=value.replaceAll(secret,'[已隐藏]');
    return value.replace(/nvl_[A-Za-z0-9_-]{43}|lb_[a-f0-9]{64}/g,'[已隐藏]');
  }
  if (Array.isArray(value)) return value.map(item=>redactBridge(item,secrets,depth+1));
  if (value!==null && typeof value==='object') {
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[redactBridge(key,secrets),redactBridge(item,secrets,depth+1)]));
  }
  return value;
}
