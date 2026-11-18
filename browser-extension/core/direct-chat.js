// SPDX-License-Identifier: GPL-3.0-only
import {DirectApi,cleanDirect,directOutput} from './direct-api.js';
import {directTools,directArguments} from './direct-tools.js';
import {executeBrowser} from './browser.js';
import {directoryPermission,executeLocalFiles,loadDirectory} from './local-directory.js';
import './intent.js';
import {simpleSearchCall,searchReply} from './baidu-search.mjs';
const STORE='navi.private.direct.runs';
const final=new Set(['completed','cancelled','failed','limit_reached']);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const callId=/^[A-Za-z0-9_.:-]{1,180}$/;
const fail=(message,code='DIRECT_REQUEST')=>{throw Object.assign(new Error(message),{code});};
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;

export class DirectChat {
  constructor({api,config,client=value=>new DirectApi(value),browser=executeBrowser}) {
    this.api=api;this.config=config;this.client=client;this.browser=browser;this.rows=[];this.jobs=new Map();this.controllers=new Map();this.writes=Promise.resolve();this.requests=Promise.resolve();
    this.ready=this.restore();
  }
  async restore() {
    const saved=(await this.api.storage.session.get(STORE))[STORE];
    this.rows=Array.isArray(saved)?saved:[];
    for (const run of this.rows) if (!final.has(run.status) && run.status!=='awaiting_approval') {
      run.uncertain=run.phase==='browser';run.status='failed';run.pending=null;
      run.error=run.uncertain?'浏览器后台已重启，操作结果未知；请核对页面，不会自动重复执行。':'浏览器后台已重启，本轮已停止；可开始新对话。';
      this.event(run,'run.failed',{message:run.error,uncertain:run.uncertain});
    }
    await this.persist();
  }
  event(run,type,data={}) {run.events.push({seq:run.events.length+1,runId:run.id,type,time:Date.now(),data});}
  snapshot(run) {return {runId:run.id,status:run.status,projectId:null,projectSelected:false,model:run.model,prompt:run.prompt,previousRunId:run.previousRunId,
    directoryId:run.directoryId ?? null,startedAt:run.startedAt,pending:run.pending,error:run.error,uncertain:run.uncertain,lastSeq:run.events.length,
    ...(run.reasoningEffort?{reasoningEffort:run.reasoningEffort}:{}),...(run.needsLocalDirectory?{needsLocalDirectory:true}:{})};}
  persist() {
    while ((this.rows.length>20 || bytes(this.rows)>6_000_000) && this.rows.some(run=>final.has(run.status))) {
      const index=this.rows.findIndex((run,i)=>final.has(run.status)&&i<this.rows.length-1);
      if(index<0)break;this.rows.splice(index,1);
    }
    const saved=structuredClone(this.rows);
    const next=this.writes.then(()=>this.api.storage.session.set({[STORE]:saved}));this.writes=next.catch(()=>{});return next;
  }
  active() {return this.rows.some(run=>!final.has(run.status));}
  async reset() {await this.ready;if(this.active())fail('请先停止或完成当前对话，再更换模型连接。');this.rows=[];await this.persist();}
  get(id,config) {const run=this.rows.find(item=>item.id===id&&item.revision===config?.revision);if(!run)fail('此独立对话不存在或模型连接已更换。');return run;}
  async handle(message) {
    const result=this.requests.then(()=>this.handleSerial(message));this.requests=result.catch(()=>{});return result;
  }
  async handleSerial(message) {
    await this.ready;
    const config=await this.config();
    if(message.type==='chat.context') return {mode:'direct',project:null,models:config?.models || [],defaultModel:config?.defaultModel || '',modelConfigured:Boolean(config?.key),
      connectionId:config?.revision || 'direct-unconfigured',automation:true,testing:false,capabilities:{projectSelection:true,browserAutomation:true,independent:true}};
    if(message.type==='chat.runs')return {runs:this.rows.filter(run=>run.revision===config?.revision).slice().reverse().map(run=>this.snapshot(run))};
    if(message.type==='chat.create') {
      if(!config?.key)fail('请先在模型设置中保存 API 地址和 Key，无需连接 MCP。');
      const prompt=typeof message.prompt==='string'?message.prompt.trim():'';
      if(!prompt || prompt.length>16000 || !uuid.test(message.clientRequestId || '') || !config.models.some(model=>model.id===message.model))fail('请填写消息并选择可用模型。');
      const reasoningEffort=message.reasoningEffort || null;
      if(reasoningEffort && !config.models.find(model=>model.id===message.model)?.reasoningEfforts?.includes(reasoningEffort)) fail('此模型未声明支持所选思考强度，请刷新模型配置。');
      const directoryId=message.directoryId ?? null;
      if(directoryId!==null && (typeof directoryId!=='string' || !uuid.test(directoryId))) fail('本地目录编号无效。');
      const fingerprint=JSON.stringify([prompt,message.model,message.previousRunId || null,reasoningEffort,...(directoryId?[directoryId]:[])]);
      const prior=this.rows.find(run=>run.revision===config.revision&&run.clientRequestId===message.clientRequestId);
      if(prior){if(prior.fingerprint!==fingerprint)fail('此消息编号已用于其他请求。');return this.snapshot(prior);}
      if(this.active())fail('请先完成或停止当前任务。');
      if(directoryId) {
        const directory=await loadDirectory();
        if(directory?.id!==directoryId || !await directoryPermission(directory)) fail('本地目录已更换或需要重新授权。','DIRECTORY_PERMISSION');
      }
      let input=[],conversationId=crypto.randomUUID();
      if(message.previousRunId){const previous=this.get(message.previousRunId,config);if(previous.status!=='completed'||previous.model!==message.model || (previous.directoryId ?? null)!==directoryId)fail('请使用相同模型和目录继续对话，或开始新对话。');input=structuredClone(previous.input);conversationId=previous.conversationId;}
      input.push({role:'developer',content:'当前 UTC 时间：'+new Date().toISOString()},{role:'user',content:prompt});
      if(bytes(input)>450_000)fail('对话内容较长，请开始新对话。');
      const run={id:crypto.randomUUID(),revision:config.revision,clientRequestId:message.clientRequestId,fingerprint,model:message.model,prompt,input,conversationId,turnId:crypto.randomUUID(),
        reasoningEffort,directoryId,previousRunId:message.previousRunId || null,startedAt:Date.now(),status:'queued',events:[],queue:[],seen:[],round:0,count:0,pending:null};
      const search=simpleSearchCall(prompt,()=>crypto.randomUUID());
      if(search){
        run.searchQuery=JSON.parse(search.arguments).query;
        run.input.push(search);run.queue.push(structuredClone(search));run.seen.push(search.call_id);run.count++;
      }
      this.rows.push(run);this.event(run,'run.queued');await this.persist();this.kick(run.id);return this.snapshot(run);
    }
    const run=this.get(message.runId,config);
    if(message.type==='chat.events') {
      if(!Number.isSafeInteger(message.after)||message.after<0)fail('事件序号无效。');
      const events=run.events.slice(message.after,message.after+30);return {run:this.snapshot(run),events,next:events.at(-1)?.seq ?? message.after};
    }
    if(message.type==='chat.cancel') {
      if(!final.has(run.status)){run.uncertain=run.phase==='browser';run.status='cancelled';run.pending=null;this.controllers.get(run.id)?.abort();this.event(run,'run.cancelled',{uncertain:run.uncertain});await this.persist();}
      return this.snapshot(run);
    }
    if(message.type==='chat.decision') {
      if(run.status!=='awaiting_approval'||run.pending?.callId!==message.callId||!['approve','deny'].includes(message.decision))fail('工具请求已处理或失效。');
      run.queue[0].decision=message.decision;run.pending=null;run.status='running';this.event(run,'approval.decided',{callId:message.callId,decision:message.decision});await this.persist();this.kick(run.id);return this.snapshot(run);
    }
    fail('独立模式不支持此操作。');
  }
  kick(id) {
    if(this.jobs.has(id))return;
    const job=Promise.resolve().then(()=>this.pump(id)).finally(()=>{this.jobs.delete(id);const run=this.rows.find(item=>item.id===id);if(run?.status==="running" && run.queue[0]?.decision)this.kick(id);});
    this.jobs.set(id,job);void job.catch(()=>{});
  }
  async pump(id) {
    const config=await this.config(),run=this.get(id,config),controller=new AbortController();this.controllers.set(id,controller);
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8*60_000)]);
    const check=()=>{signal.throwIfAborted();if(final.has(run.status))throw new Error('运行已结束。');};
    const output=(call,data)=>{
      const cleaned=JSON.parse(cleanDirect(data,config.key));
      this.event(run,'tool.result',{tool:call.name,callId:call.call_id,status:cleaned.ok?'ok':'error',output:cleaned});
      run.input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(cleaned)});run.queue.shift();run.pending=null;run.phase=null;
    };
    const finishWithNotice=async text=>{
      run.input.push({type:'message',role:'assistant',content:[{type:'output_text',text}]});
      this.event(run,'model.text',{text,final:true});run.status='completed';this.event(run,'run.completed');await this.persist();
    };
    try {
      while(!final.has(run.status)) {
        check();if(Date.now()-run.startedAt>8*60_000)throw new Error('本轮任务已超过时限。');
        if(bytes(run.input)>500_000)throw new Error('对话上下文较长，请开始新对话。');
        if(run.queue.length) {
          const call=run.queue[0];
          let args;
          try {args=directArguments(call);} catch(error){output(call,{ok:false,message:error.message});await this.persist();continue;}
          if(call.name==='navi_local_required') {
            output(call,{ok:false,localConnectionRequired:true,message:'此操作需要本机 Navi。'});
            while(run.queue.length)output(run.queue[0],{ok:false,message:'请先连接本机工具。'});
            await finishWithNotice('在 Finder 打开目录、写入文件或运行项目测试，请在设置中选择「使用本机 Navi」，再点击「连接 Navi」。Navi Link 尚不支持整桌面控制。');return;
          }
          const localFile=call.name==='navi_local_files';
          if(localFile && !run.directoryId) {
            while(run.queue.length)output(run.queue[0],{ok:false,message:'请先连接本地目录。'});
            run.needsLocalDirectory=true;
            await finishWithNotice('请选择要访问的本地目录。');return;
          }
          if(!call.decision){
            run.pending={kind:'workbench',tool:call.name,callId:call.call_id,args};
            if(localFile)run.pending.modelOrigin=new URL(config.baseUrl).origin;
            run.status='awaiting_approval';run.phase=null;this.event(run,'tool.proposed',{tool:call.name,callId:call.call_id,args});await this.persist();return;
          }
          if(call.decision==='deny'){output(call,{ok:false,code:'APPROVAL_DENIED',message:'用户拒绝此操作，未执行。'});await this.persist();continue;}
          run.status='running';run.phase=localFile?'local-file':'browser';this.event(run,'tool.started',{tool:call.name,callId:call.call_id});await this.persist();check();
          try {
            const result=localFile ? await executeLocalFiles(run.directoryId,args) : await this.browser(this.api,'direct-'+config.revision,args);
            check();output(call,result);
            if(localFile && result.code==='DIRECTORY_PERMISSION') {
              while(run.queue.length)output(run.queue[0],{ok:false,message:'请重新授权本地目录。'});
              run.needsLocalDirectory=true;
              await finishWithNotice(result.message);return;
            }
          }
          catch(error){check();if(error.uncertain){run.uncertain=true;throw error;}output(call,{ok:false,message:cleanDirect(error.message,config.key)});}
          await this.persist();continue;
        }
        if(run.searchQuery){
          const text=searchReply(JSON.parse(run.input.at(-1).output),run.searchQuery);
          run.input.push({type:'message',role:'assistant',content:[{type:'output_text',text}]});
          this.event(run,'model.text',{text,final:true});run.status='completed';this.event(run,'run.completed');await this.persist();return;
        }
        if(run.round>=12 || run.count>=24){run.status='limit_reached';this.event(run,'run.limit_reached');await this.persist();return;}
        run.status='running';run.phase='model';run.round++;
        const requireBrowser=run.round===1 && globalThis.NaviIntent.browserAction(run.prompt);
        this.event(run,'model.request',{round:run.round,model:run.model,tools:directTools.map(tool=>tool.name),requireBrowser});await this.persist();check();
        const response=await this.client(config).respond({model:run.model,input:structuredClone(run.input),tools:directTools,signal,conversationId:run.conversationId,turnId:run.turnId,reasoningEffort:run.reasoningEffort,requireBrowser});check();
        const parsed=directOutput(JSON.parse(cleanDirect(response,config.key)));
        if(requireBrowser && !parsed.calls.some(call=>call.name==='navi_browser')) throw new Error('已向模型提供 navi_browser 并要求浏览器调用，但服务未返回该调用，本轮未执行。请确认所选模型和 API 支持 Responses 工具调用。');
        if(bytes([...run.input,...parsed.items])>500_000)throw new Error("模型结果过长，请缩小任务或开始新对话。");
        if(parsed.calls.some(call=>!callId.test(call.call_id || '') || run.seen.includes(call.call_id)) || new Set(parsed.calls.map(call=>call.call_id)).size!==parsed.calls.length)throw new Error('模型返回重复或缺失的工具调用编号。');
        if(run.count+parsed.calls.length>24)throw new Error('本轮工具调用过多，请缩小任务。');
        run.input.push(...JSON.parse(cleanDirect(parsed.items,config.key)));run.seen.push(...parsed.calls.map(call=>call.call_id));run.count+=parsed.calls.length;
        if(parsed.text)this.event(run,'model.text',{text:cleanDirect(parsed.text,config.key).slice(0,45000),final:!parsed.calls.length});
        run.queue=structuredClone(parsed.calls);run.phase=null;
        if(!parsed.calls.length){if(!parsed.text.trim())throw new Error('模型未返回文本。');run.status='completed';this.event(run,'run.completed');await this.persist();return;}
        await this.persist();
      }
    } catch(error) {
      if(run.status!=='cancelled'){run.status='failed';run.pending=null;run.error=cleanDirect(error.message || '独立对话失败。',config?.key).slice(0,500);this.event(run,'run.failed',{message:run.error,uncertain:run.uncertain});}
      await this.persist();
    } finally {this.controllers.delete(id);}
  }
}
