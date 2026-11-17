// SPDX-License-Identifier: GPL-3.0-only
import {browserUrl} from './browser.js';
const string={type:'string'};
export const directTools=[
  {type:'function',name:'navi_browser',description:'操作当前浏览器：open 打开完整网址；search 在百度搜索 query；read 读取本次连接打开的标签页，返回文字和 selector；click/fill 使用读取到的 selector 点击/填写。read/click/fill 必须传 tabId 和最近观察到的完整 url，每次操作需用户确认。无需 MCP 或本地项目。',strict:false,
    parameters:{type:'object',properties:{action:{type:'string',enum:['open','search','read','click','fill']},url:string,query:string,tabId:{type:'integer'},selector:string,text:string},required:['action'],additionalProperties:false}},
  {type:'function',name:'navi_local_required',description:'只有用户需要读写本机文件、打开本地目录或控制桌面时，说明可选本机文件工具的连接方式；当前不支持整桌面控制。普通聊天、网页搜索和网页操作不要调用此工具。',strict:false,parameters:{type:'object',properties:{},additionalProperties:false}}
];
export function directArguments(call) {
  if (typeof call.arguments!=='string' || call.arguments.length>16000) throw new Error('工具参数无效或过长。');
  let args;try {args=JSON.parse(call.arguments);} catch {throw new Error('工具参数不是合法 JSON。');}
  if (!args || typeof args!=='object' || Array.isArray(args)) throw new Error('工具参数必须是对象。');
  if (call.name==='navi_local_required') {if(Object.keys(args).length)throw new Error('本机连接请求不接收参数。');return args;}
  if (call.name!=='navi_browser') throw new Error('独立模式没有此工具。');
  const fields={open:['url'],search:['query'],read:['tabId','url'],click:['tabId','url','selector'],fill:['tabId','url','selector','text']}[args.action];
  if (!fields || Object.keys(args).some(key=>!['action',...fields].includes(key)) || fields.some(key=>!Object.hasOwn(args,key))) throw new Error('浏览器操作参数不匹配。');
  if (args.action==='search') {
    if (typeof args.query!=='string' || !args.query.trim() || args.query.length>1000) throw new Error('请输入搜索词。');
    args.url='https://www.baidu.com/s?wd='+encodeURIComponent(args.query.trim());
  } else args.url=browserUrl(args.url);
  if (fields.includes('tabId') && (!Number.isSafeInteger(args.tabId) || args.tabId<0)) throw new Error('标签页编号无效。');
  if (fields.includes('selector') && (typeof args.selector!=='string' || !args.selector || args.selector.length>1000)) throw new Error('请使用观察到的元素选择器。');
  if (fields.includes('text') && (typeof args.text!=='string' || args.text.length>4000)) throw new Error('输入内容无效或过长。');
  return args;
}
