// SPDX-License-Identifier: GPL-3.0-only
import {browserUrl} from './browser.js';
import {directoryPath} from './local-directory.js';
const string={type:'string'};
export const directTools=[
  {type:'function',name:'navi_browser',description:'操作当前浏览器：open 打开完整网址；search 在百度搜索 query；read 读取本次连接打开的标签页，返回文字和 selector；click/fill 使用读取到的 selector 点击/填写。read/click/fill 必须传 tabId 和最近观察到的完整 url，每次操作需用户确认。无需 MCP 或本地项目。',strict:false,
    parameters:{type:'object',properties:{action:{type:'string',enum:['open','search','read','click','fill']},url:string,query:string,tabId:{type:'integer'},selector:string,text:string},required:['action'],additionalProperties:false}},
  {type:'function',name:'navi_local_files',description:'在用户通过浏览器选择的本地目录内列目录或读取 UTF-8 文本。list 列一个目录，根目录使用 .；read 读取一个文件。path 使用目录内相对路径。每次操作需用户批准，未连接目录时会提示用户选择。',strict:false,
    parameters:{type:'object',properties:{action:{type:'string',enum:['list','read']},path:string},required:['action','path'],additionalProperties:false}},
  {type:'function',name:'navi_local_required',description:'用户明确要求创建或修改本机文件、在 Finder 中打开目录、运行项目测试或控制桌面时，提示本机工具的连接方式和能力。列目录和读取文本使用 navi_local_files。',strict:false,parameters:{type:'object',properties:{},additionalProperties:false}}
];
export function directArguments(call) {
  if (typeof call.arguments!=='string' || call.arguments.length>16000) throw new Error('工具参数无效或过长。');
  let args;try {args=JSON.parse(call.arguments);} catch {throw new Error('工具参数不是合法 JSON。');}
  if (!args || typeof args!=='object' || Array.isArray(args)) throw new Error('工具参数必须是对象。');
  if (call.name==='navi_local_required') {if(Object.keys(args).length)throw new Error('本机连接请求不接收参数。');return args;}
  if (call.name==='navi_local_files') {
    if (!['list','read'].includes(args.action) || Object.keys(args).some(key => !['action','path'].includes(key))) throw new Error('目录工具只支持列目录和读取文本。');
    directoryPath(args.path,args.action);
    return args;
  }
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
