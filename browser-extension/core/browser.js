// SPDX-License-Identifier: GPL-3.0-only
// Fixed operations only: no model-supplied code and no access to unrelated tabs.
export function browserUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('网址无效。');
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('::ffff:')) {
    throw new Error('只能操作 HTTP/HTTPS 网页，不能操作本机管理页面。');
  }
  return url.href;
}

// This function is serialized by Chrome and runs in the isolated world.
export function pageOperation(action, expectedUrl, selector, text, expectedElement) {
  try {
  if (location.href !== expectedUrl) throw new Error('页面已跳转，请重新读取后确认。');
  const signature = node => ({tag:node.tagName,type:node.getAttribute('type') || '',
    label:(node.getAttribute('aria-label') || node.innerText || node.getAttribute('placeholder') || '').slice(0,160)});
  const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  if (action === 'read') {
    const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
      .filter(node => visible(node) && !['password','hidden','file'].includes(node.getAttribute('type'))).slice(0,70).map(node => {
        const parts=[];
        for (let current=node;current && current.nodeType===1;current=current.parentElement) {
          if (current.id) { parts.unshift('#'+CSS.escape(current.id)); break; }
          const tag=current.tagName.toLowerCase();
          const siblings=current.parentElement ? [...current.parentElement.children].filter(sibling=>sibling.tagName===current.tagName) : [current];
          parts.unshift(tag+':nth-of-type('+(siblings.indexOf(current)+1)+')');
        }
        return {selector:parts.join(' > '),...signature(node)};
      });
    const result={url:location.href,title:document.title,text:(document.body?.innerText || '').slice(0,8000),elements};
    while (new TextEncoder().encode(JSON.stringify(result)).byteLength>28000 && elements.length) elements.pop();
    while (new TextEncoder().encode(JSON.stringify(result)).byteLength>28000 && result.text.length) result.text=result.text.slice(0,-1000);
    return result;
  }
  const matches = document.querySelectorAll(selector);
  if (matches.length !== 1 || !visible(matches[0])) throw new Error('元素不存在、不唯一或不可见，请重新读取页面。');
  const node=matches[0];
  if (!expectedElement || Object.entries(signature(node)).some(([key,value])=>expectedElement[key]!==value)) throw new Error('元素已变化，请重新读取后确认。');
  if (['password','file','hidden'].includes(node.getAttribute('type')) || node.disabled || node.readOnly) throw new Error('此输入控件不支持自动操作。');
  if (action === 'fill') {
    if (!['INPUT','TEXTAREA'].includes(node.tagName)) throw new Error('仅支持普通文本输入框。');
    const prototype = node.tagName==='INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    node.focus();
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,text);
    node.dispatchEvent(new Event('input',{bubbles:true}));
    node.dispatchEvent(new Event('change',{bubbles:true}));
    return {url:location.href,action,filled:true};
  }
  if (action === 'click') {
    const link=node.closest('a');
    if (link && (!['http:','https:'].includes(new URL(link.href).protocol) || link.hasAttribute('download'))) throw new Error('不支持下载或非网页链接。');
    node.click();
    return {url:location.href,action,clicked:true,message:'已触发点击；页面变化需再次读取确认。'};
  }
  throw new Error('未知网页操作。');
  } catch(error) { return {operationError:String(error.message || '网页操作失败。').slice(0,400)}; }
}

export async function executeBrowser(api, grantId, args) {
  const url = browserUrl(args.url);
  const key='navi.browser.tabs.'+grantId;
  const records=(await api.storage.session.get(key))[key] || {};
  if (['open','search'].includes(args.action)) {
    let tab;
    try { tab=await api.tabs.create({url,active:true}); } catch(error) { error.uncertain=true; throw error; }
    if (!Number.isInteger(tab.id)) throw new Error('浏览器没有返回标签页编号。');
    records[tab.id]={};
    try { await api.storage.session.set({[key]:records}); } catch(error) { error.uncertain=true; throw error; }
    return {ok:true,tabId:tab.id,url,opened:true,message:'已创建浏览器标签页并提交网址；尚未读取页面内容。'};
  }
  if (!['read','click','fill'].includes(args.action) || !Number.isSafeInteger(args.tabId) || !Object.hasOwn(records,args.tabId)) throw new Error('只能操作当前连接通过 Navi 打开的标签页。');
  const tab=await api.tabs.get(args.tabId);
  if (tab.pendingUrl || browserUrl(tab.url)!==url) throw new Error('页面正在跳转或网址已变化，请使用当前网址重新读取。当前网址：'+(tab.pendingUrl || tab.url || '未知'));
  if (!(await api.permissions.contains({origins:[new URL(url).origin+'/*']}))) throw new Error('尚未授权此网站，请在侧栏批准时允许网站访问。');
  const record=records[args.tabId];
  const item=record.elements?.find(item=>item.selector===args.selector);
  if (args.action!=='read' && (!record.documentId || record.url!==url || !item)) throw new Error('请先读取此页面，使用返回的元素选择器。');
  const signature=item && {tag:item.tag,type:item.type,label:item.label};
  if (args.action==='fill' && (typeof args.text!=='string' || args.text.length>4000)) throw new Error('输入内容无效。');
  let results;
  try { results=await api.scripting.executeScript({
    target:args.action==='read' ? {tabId:args.tabId,frameIds:[0]} : {tabId:args.tabId,documentIds:[record.documentId]},
    func:pageOperation,args:[args.action,url,args.selector ?? null,args.text ?? null,signature ?? null],world:'ISOLATED'
  }); } catch(error) { if (args.action!=='read') error.uncertain=true; throw error; }
  const observed=results[0];
  if (!observed?.result) throw Object.assign(new Error('未收到网页操作结果，请检查页面，勿盲目重试。'),{uncertain:args.action!=='read'});
  if (observed.result.operationError) throw new Error(observed.result.operationError);
  if (args.action==='read') records[args.tabId]={url,documentId:observed.documentId,elements:observed.result.elements};
  else records[args.tabId]={}; // Every subsequent mutation requires a new observation.
  try { await api.storage.session.set({[key]:records}); } catch(error) { if (args.action!=='read') error.uncertain=true; throw error; }
  return {ok:true,tabId:args.tabId,...observed.result};
}
