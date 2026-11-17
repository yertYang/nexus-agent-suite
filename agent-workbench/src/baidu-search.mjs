// SPDX-License-Identifier: GPL-3.0-only
// Kept identical in the two standalone applications.
export function simpleSearchCall(prompt, callId, projectId) {
  // Match a command and a short literal topic. Leave questions and follow-up actions to chat.
  const match = /^(?:(?:请|帮我|麻烦)\s*){0,2}(?:(?:用|通过|在)\s*(?:现有|当前|谷歌)?\s*(?:chrome(?:浏览器)?|edge(?:浏览器)?|浏览器)\s*(?:中)?\s*)?(?:(?:打开|访问|在)\s*)?百度(?:网站|首页|上)?\s*[,，]?\s*(?:并)?搜索\s*([\p{L}\p{N}][\p{L}\p{N} +#-]{0,59}?)[。！!]?$/iu.exec(prompt);
  if (!match || /[\r\n]/.test(prompt)) return null;
  const query = match[1].trim();
  if (/并|然后|之后|接着|接下来|再|读取|查看|点击|填写|总结|概括|告诉|整理|提取|返回|分析|列出|打开|保存|下载|翻译|搜索结果|^(?:它|这个|刚才|上面|上述)|(?:吗|么|吧)$|\b(?:then|and|summari[sz]e|click|read)\b/i.test(query)) return null;
  return {type:'function_call', name:'navi_browser', call_id:callId(),
    arguments:JSON.stringify({action:'search',query,...(projectId===undefined?{}:{projectId})})};
}

export function searchReply(result, query) {
  if (result?.code === 'APPROVAL_DENIED') return '已拒绝，未打开搜索页。';
  if (!result?.ok || result.opened !== true) throw new Error(result?.message || '未收到浏览器已打开搜索页的确认。');
  return '已在新标签页打开百度搜索「'+query+'」，尚未读取搜索结果。';
}
