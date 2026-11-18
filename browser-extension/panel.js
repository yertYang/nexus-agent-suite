// SPDX-License-Identifier: GPL-3.0-only
import {directoryPermission,loadDirectory,saveDirectory} from './core/local-directory.js';

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const terminal = new Set(["completed", "failed", "cancelled", "limit_reached"]);
  const labels = { queued: "等待开始", running: "Navi 正在处理", awaiting_approval: "等待你确认工具", completed: "已完成",
    failed: "运行失败", cancelled: "已停止", limit_reached: "已达到运行上限" };
  const screenshots = new Map();
  const s = { connection: null, context: null, authenticated: false, checking: false, reconnectRequired: false,
    generation: 0, chain: [], runningPoll: false, busy: false, model: "", effort:"", setupStatus: "", uncertainCreate: null, projectSelected:false, showProjectPicker:false };
  let localDirectory, directoryGranted = false;
  const latest = () => s.chain.at(-1);
  const isActive = () => Boolean(latest() && !terminal.has(latest().run.status));
  const canBrowser = () => (s.context?.browserAutomation ?? s.context?.automation) === true;
  const canFiles = () => s.context?.mode !== "direct" && (s.context?.fileOperations ?? s.context?.automation) === true;
  const eligible = () => s.authenticated && s.context?.modelConfigured && s.context?.capabilities?.projectSelection === true && s.context.models.some((m) => m.id === s.model);
  const mk = (tag, classes, text) => {
    const node = document.createElement(tag);
    if (classes) node.className = classes;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, variant, click) => {
    const node = mk("button", "nv-button", text);
    node.type = "button";
    node.dataset.variant = variant;
    node.dataset.size = "sm";
    node.addEventListener("click", (event) => { if (event.isTrusted) void click(); });
    return node;
  };
  const settingsLink = () => {
    const link = mk("a", "", "打开 Navi 连接设置 ↗");
    link.href = "http://127.0.0.1:17880/#settings";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  };
  async function ask(type, args = {}) {
    const answer = await chrome.runtime.sendMessage({ type: "chat." + type, ...args });
    if (!answer?.ok) {
      const error = new Error(answer?.error || "侧栏暂时不可用。");
      error.code = answer?.code;
      throw error;
    }
    return answer.data;
  }
  function status(text, error = false) {
    const node = $("chat-status");
    node.replaceChildren(text);
    node.hidden = !text;
    node.dataset.error = String(error);
  }
  function discloseConnection() {
    if (!$("bridge-settings").open) $("bridge-settings").showModal();
    (s.context?.mode==="direct" && !s.context.modelConfigured ? $("direct-url") : $("close-settings")).focus();
  }
  function handleError(error) {
    if (error.code === "BRIDGE_RECONNECT") {
      s.authenticated = false;
      s.reconnectRequired = true;
      s.setupStatus = "侧栏连接已失效。";
      status("请在连接设置中重新连接 Navi；当前消息已保留。", true);
      syncControls();
      return;
    }
    if (error.code === "MODEL_NOT_CONFIGURED") {
      if (s.context) s.context.modelConfigured = false;
      status("请在 Navi 保存并连接 API URL 和 Key。", true);
      $("chat-status").append(" ", settingsLink());
      syncControls();
      return;
    }
    status(error.message, true);
  }
  function syncControls() {
    const active = s.authenticated && isActive();
    const send = eligible() && !active && !s.busy && !s.uncertainCreate;
    $("chat-prompt").disabled = !eligible();
    $("send-chat").disabled = !send || !$("chat-prompt").value.trim();
    if (s.busy && !active) $("send-chat").setAttribute("aria-busy", "true");
    else $("send-chat").removeAttribute("aria-busy");
    $("recover-chat").hidden = !s.uncertainCreate;
    $("recover-chat").disabled = !s.authenticated || s.busy;
    $("stop-chat").hidden = !active;
    $("stop-chat").disabled = s.busy;
    const direct = s.context?.mode === "direct";
    const choose = $("choose-project");
    const chooseLabel = direct ? "本地目录" : "选择项目";
    choose.disabled = !(direct ? s.authenticated : eligible()) || s.busy || active;
    choose.setAttribute("aria-label",chooseLabel);
    choose.title = chooseLabel;
    $("send-chat").hidden = active;
    $("chat-model").disabled = !s.authenticated || s.busy || active || !s.context?.models.length;
    $("chat-effort").disabled = s.busy || active;
    $("new-chat").disabled = !s.chain.length || s.busy || active || !!s.uncertainCreate;
    $("automation-grant").hidden = !s.authenticated;
    $("testing-grant").hidden = !s.authenticated || s.context?.testing !== true;
    $("disconnect-chat").hidden = !s.authenticated || s.context?.mode==="direct";
    $("automation-grant").textContent=s.context?.mode==="direct" ? "独立模式 · 网页工具可用" : canBrowser() ? "已授权浏览器操作" : "本机模式 · 网页操作未授权";
    $("automation-grant").dataset.tone=canBrowser() ? "info" : "warning";
    $("file-grant").hidden=!s.authenticated || !(direct ? directoryGranted : canFiles());
    $("file-grant").textContent=direct ? "本地目录已连接" : "已授权本机文件操作";
    for (const id of ["chat-mode","direct-save","direct-clear"]) $(id).disabled=s.busy || active || (id==="direct-clear" && !s.connection?.directConfigured);
    $("disconnect-chat").disabled = s.busy;
    for (const control of document.querySelectorAll(".chat-approval button")) control.disabled = s.busy || !s.authenticated;
    const caption = $("composer-caption");
    if (s.context?.mode!=="direct" && s.authenticated && !s.context?.modelConfigured) caption.replaceChildren(settingsLink());
    else caption.textContent = eligible() ? "Enter 发送 · Shift + Enter 换行" : "在模型设置中连接 API";
  }
  function renderContext() {
    const model = $("chat-model"), info = s.context;
    model.replaceChildren(...(info?.models.length
      ? info.models.map((entry) => new Option(entry.label || entry.id, entry.id))
      : [new Option(info ? "暂无可用模型" : "连接后选择", "")]));
    if ("HTMLSelectedContentElement" in window) {
      for (const select of [model]) {
        const display = document.createElement("button"); display.type = "button";
        display.append(document.createElement("selectedcontent")); select.prepend(display);
      }
    }
    if (!info?.models.some((entry) => entry.id === s.model)) s.model = info?.defaultModel || info?.models[0]?.id || "";
    model.value = s.model;
    // Chromium may leave dynamically inserted selectedcontent empty when the
    // selected option did not change. Seed it for the initial/default model.
    const display = model.querySelector("selectedcontent");
    if (display) display.textContent = model.selectedOptions[0]?.textContent || "";
    renderEffort();
    syncControls();
  }
  function renderEffort() {
    const select = $("chat-effort");
    const options = s.context?.mode === "direct" ? s.context.models.find(model => model.id === s.model)?.reasoningEfforts || [] : [];
    const labels = {none:"不思考",minimal:"极低",low:"低",medium:"中",high:"高",xhigh:"极高"};
    if (!options.includes(s.effort)) s.effort = "";
    select.replaceChildren(new Option("默认强度", ""), ...options.map(value => new Option("思考 · " + labels[value], value)));
    select.value = s.effort;
    select.hidden = !options.length;
  }
  function message(role, content) {
    const container = mk("article", "message");
    container.dataset.role = role;
    container.append(mk("h2", "message-title", role === "user" ? "你" : "Navi"), role === "user" ? document.createTextNode(content) : NaviReply.render(content, {copyIcon:true}));
    return container;
  }
  const stages = new Map([["tool.proposed","提议"],["approval.decided","审批"],["tool.started","开始执行"],["tool.result","结果"]]);
  function disclosure(key, open, css, title) {
    const row=mk("details",css);
    row.dataset.event=key;
    row.open=open.has(key);
    row.append(mk("summary","",title));
    return row;
  }
  function actionLabel(tool,args) {
    if (tool==="navi_browser") return ({search:"百度搜索「"+args?.query+"」",open:"打开网页",read:"读取网页",fill:"填写网页",click:"点击网页元素"})[args?.action] || "浏览器操作";
    if (tool==="navi_local_files") return args?.action==="list" ? "列出本地目录" : "读取本地文件";
    return tool==="navi_open_directory" ? "打开项目目录" : tool || "工具调用";
  }
  function operationHistory(item,open) {
    const calls=new Map();
    for(const event of item.events) {
      if (!stages.has(event.type)) continue;
      const id=event.data?.callId ?? event.seq;
      if (!calls.has(id)) calls.set(id,[]);
      calls.get(id).push(event);
    }
    if (!calls.size) return null;
    const key=item.run.runId+":history", title="操作记录 · "+calls.size+" 次操作";
    const log=disclosure(key,open,"operation-history",title);
    const toggle=log.firstChild;
    toggle.setAttribute("aria-label",title);
    toggle.title=title;
    toggle.replaceChildren();
    const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg"),path=document.createElementNS(ns,"path");
    svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");
    path.setAttribute("d","M3 5v5h5 M3.8 10a8.3 8.3 0 1 1 .6 6 M12 7v5l3 2");svg.append(path);toggle.append(svg);
    log.append(mk("p","help",title));
    const notices=new Set();
    for (const [id,events] of calls) {
      const proposed=events.find(e=>e.type==="tool.proposed")?.data;
      const result=events.findLast(e=>e.type==="tool.result")?.data;
      const denied=events.some(e=>["deny","denied","rejected","expired"].includes(e.data?.decision));
      const state=result?.status==="unknown" || (!result && item.run.uncertain) ? "结果未知" : denied ? "已拒绝" : result?.status==="error" ? "失败" : result?.status==="ok" ? "成功" : item.run.status==="cancelled" ? "已停止" : item.run.pending?.callId===id ? "待批准" : terminal.has(item.run.status) ? "未完成" : "处理中";
      const label=actionLabel(proposed?.tool || result?.tool,proposed?.args);
      if(["结果未知","已拒绝","失败"].includes(state)) notices.add(label+"："+state);
      const call=disclosure(key+":"+id,open,"operation-call",label+" · "+state);
      for(const event of events) {
        const stage=disclosure(key+":event:"+event.seq,open,"operation-stage",stages.get(event.type));
        stage.append(mk("pre","",JSON.stringify(event.data,null,2)));call.append(stage);
      }
      log.append(call);
    }
    const group=mk("div","operation-group");
    if(notices.size) group.append(mk("p","operation-notice",[...notices].join("；")));
    group.append(log);return group;
  }
  function approvalCard(run) {
    const pending = run.pending;
    const card = mk("div", "nv-card chat-approval");
    card.append(mk("h2", "", pending.kind === "nexus" ? "Nexus 要求审批" : "确认此工具调用"),
      mk("p", "", pending.summary || actionLabel(pending.tool,pending.args)));
    if (pending.tool==="navi_local_files") {
      const name=localDirectory?.id===run.directoryId ? localDirectory.handle.name : "原授权目录";
      card.append(mk("pre","",name + "/" + pending.args.path),
        mk("p","help",(pending.args.action==="list" ? "目录列表" : "读取的文本") + "将发送给模型服务 " + pending.modelOrigin + "。"));
    } else if (pending.tool==="navi_browser" && pending.args?.action==="search") card.append(mk("p","help","将打开 "+pending.args.url));
    else if (pending.args) card.append(mk("pre", "", JSON.stringify(pending.args, null, 2)));
    const actions = mk("div", "nv-row actions");
    if (pending.kind === "workbench") {
      for (const [action, label, variant] of [["deny", "拒绝", "secondary"], ["approve", "批准本次", "primary"]]) {
        const control = button(label, variant, async () => {
          try {
            if (action === "approve" && pending.tool === "navi_browser" && ["read","click","fill"].includes(pending.args?.action)) {
              const origin=new URL(pending.args.url).origin+"/*";
              if (!(await chrome.permissions.request({origins:[origin]}))) throw new Error("未允许网站访问，此操作尚未批准。");
            }
            await act("decision", { runId: run.runId, decision: action, callId: pending.callId });
          } catch(error) { handleError(error); }
        });
        control.disabled = s.busy || !s.authenticated;
        actions.append(control);
      }
    } else if (pending.kind === "nexus" && /^approval_[a-f0-9-]{36}$/i.test(pending.approvalId ?? "")) {
      const link = mk("a", "nv-button", "打开 Nexus 审批 ↗");
      link.href = "http://127.0.0.1:17880/#approvals?approvalId=" + encodeURIComponent(pending.approvalId);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      actions.append(link);
    }
    card.append(actions);
    return card;
  }
  function testReport(event) {
    const report = event.data?.report;
    if (!report || !["passed", "failed", "blocked", "unverified"].includes(report.status)) return null;
    const card = mk("section", "nv-card test-report");
    const header = mk("div", "nv-row test-title");
    const badge = mk("span", "nv-status", ({ passed:"通过",failed:"失败",blocked:"已阻止",unverified:"未验证" })[report.status]);
    badge.dataset.tone = ({ passed:"success",failed:"danger",blocked:"warning",unverified:"neutral" })[report.status];
    header.append(mk("h2", "", report.mode === "script" ? "脚本测试报告" : "文档用例测试报告"), badge);
    card.append(header);
    if (typeof report.targetUrl === "string") card.append(mk("p", "", "目标：" + report.targetUrl));
    if (typeof report.message === "string") card.append(mk("p", "", report.message));
    if (Array.isArray(report.sources) && report.sources.length) {
      const sources = mk("ul");
      for (const source of report.sources.slice(0, 8)) if (typeof source?.path === "string") sources.append(mk("li", "", source.path));
      card.append(sources);
    }
    if (Array.isArray(report.steps) && report.steps.length) {
      const steps = mk("ol");
      const actions = { goto:"打开网页",click:"点击",fill:"填写",expectText:"检查文字",expectVisible:"检查是否可见",
        select:"选择",check:"更新勾选",screenshot:"截图",setup:"准备浏览器" };
      for (const step of report.steps.slice(0, 15)) {
        const label = actions[step.action] || String(step.action).slice(0, 60);
        steps.append(mk("li", "", label + " · " + (step.status === "passed" ? "通过" : "失败") +
          (typeof step.error === "string" ? " · " + step.error : "")));
      }
      card.append(steps);
    }
    if (report.tests && [report.tests.passed, report.tests.failed, report.tests.skipped].every(Number.isSafeInteger)) {
      card.append(mk("p", "", `${report.tests.passed} 通过 · ${report.tests.failed} 失败 · ${report.tests.skipped} 跳过`));
    }
    if (report.stdout || report.stderr) {
      const output = mk("details");
      output.append(mk("summary", "", "查看脚本输出"));
      output.append(mk("pre", "", [report.stdout, report.stderr].filter(Boolean).join("\n")));
      card.append(output);
    }
    for (const artifact of Array.isArray(report.artifacts) ? report.artifacts.slice(0, 6) : []) {
      if (artifact?.mime !== "image/jpeg" || typeof artifact.artifactId !== "string") continue;
      const key = event.runId + ":" + artifact.artifactId;
      const item = screenshots.get(key);
      if (item?.base64) {
        const figure = mk("figure");
        const image = mk("img");
        image.src = "data:image/jpeg;base64," + item.base64;
        image.alt = "测试时的页面截图";
        image.decoding = "async";
        figure.append(image);
        card.append(figure);
      } else {
        const show = button(item?.loading ? "正在加载截图…" : "查看截图", "secondary", async () => {
          const generation = s.generation;
          if (screenshots.has(key) || !s.authenticated) return;
          screenshots.set(key, { loading: true });
          renderTranscript();
          try {
            const value = await ask("artifact", { runId: event.runId, artifactId: artifact.artifactId });
            if (generation !== s.generation) return;
            screenshots.set(key, value);
          } catch (error) {
            screenshots.delete(key);
            if (generation === s.generation) {
              if (error.code === "BRIDGE_RECONNECT") handleError(error);
              else status("无法加载测试截图。", true);
            }
          } finally { if (generation === s.generation) renderTranscript(); }
        });
        show.disabled = !s.authenticated || Boolean(item?.loading);
        card.append(show);
      }
    }
    return card;
  }
  async function refreshDirectory() {
    const directory = await loadDirectory();
    const granted = await directoryPermission(directory);
    const changed = localDirectory?.id !== directory?.id || directoryGranted !== granted;
    localDirectory = directory;
    directoryGranted = granted;
    return changed;
  }
  async function manageDirectory(action) {
    if (s.busy || isActive() || s.context?.mode !== "direct") return;
    const resume = action !== "disconnect" && latest()?.run.needsLocalDirectory ? latest().run.prompt : null;
    let ready = false;
    s.busy = true;
    syncControls();
    try {
      if (action === "choose") {
        if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持选择目录，请使用 Chrome 或 Edge。");
        const handle = await window.showDirectoryPicker({mode:"read"});
        await saveDirectory({id:crypto.randomUUID(),handle});
      } else if (action === "reauthorize") {
        if (await localDirectory.handle.requestPermission({mode:"read"}) !== "granted") throw new Error("浏览器未授权访问此目录。");
      } else {
        await saveDirectory(null);
      }
      await refreshDirectory();
      ready = directoryGranted;
      s.showProjectPicker = !ready && action !== "disconnect";
      status(ready ? "已连接目录「" + localDirectory.handle.name + "」。" : "本地目录已断开。");
    } catch (error) {
      if (error.name !== "AbortError") status(error.name === "SecurityError" ? "浏览器无法打开文件夹选择器，请重试。" : error.message, true);
    } finally {
      s.busy = false;
      renderTranscript(true);
    }
    if (ready && resume) await submitPrompt(resume);
  }
  function localDirectoryChoice() {
    const card=mk("section","nv-card nv-stack project-choice");
    card.append(mk("h2","","连接本地目录"));
    const description=localDirectory ? (directoryGranted ? "已连接「" : "需要重新授权「") + localDirectory.handle.name + "」。" : "选中文件夹后，可以列目录和读取文本。";
    card.append(mk("p","",description));
    const actions=mk("div","nv-row actions");
    if (localDirectory && !directoryGranted) actions.append(button("重新授权","primary",()=>manageDirectory("reauthorize")));
    actions.append(button(localDirectory ? "选择其他目录" : "选择文件夹",localDirectory ? "secondary" : "primary",()=>manageDirectory("choose")));
    if (localDirectory) actions.append(button("断开目录","ghost",()=>manageDirectory("disconnect")));
    card.append(actions);
    return card;
  }
  function projectChoice() {
    const card=mk("section","nv-card nv-stack project-choice");
    if (!s.context.project) {
      card.append(mk("h2","","连接本机 Navi"),mk("p","","请连接本机工作台并授权项目。"),button("设置本机连接","secondary",discloseConnection));
      return card;
    }
    card.append(mk("h2","","选择本次对话的项目"),mk("p","","网页操作无需项目。文件操作只访问你在此选择并已授权的项目。"));
    const select=mk("select","nv-select"); select.id="chat-project"; select.setAttribute("aria-label","对话项目");
    select.append(new Option("请选择项目…",""),new Option(s.context.project.name,s.context.project.id));
    const use=button("使用此项目","primary",async()=>{
      if (select.value!==s.context.project.id || isActive()) return;
      const resume=latest()?.run.needsProject ? latest().run.prompt : null;
      s.projectSelected=true; s.showProjectPicker=false; renderTranscript(true);
      if (resume) await submitPrompt(resume);
    });
    use.disabled=true; select.addEventListener("change",()=>{use.disabled=select.value!==s.context.project.id;});
    const change=button("选择其他项目…","secondary",async()=>{
      if (latest()?.run.needsProject) $("chat-prompt").value=latest().run.prompt;
      discloseConnection();
      const reply=await chrome.runtime.sendMessage({type:"popup.pair.start"});
      if (!reply?.ok) handleError(new Error(reply?.error || "无法打开项目授权页。"));
    });
    const actions=mk("div","nv-row actions"); actions.append(use,change); card.append(select,actions);
    return card;
  }
  const empty = $("chat-empty");
  function renderTranscript(forceFollow = false) {
    const scroller = $("chat-surface");
    const transcript = $("conversation");
    transcript.dataset.runStatus = latest()?.run.status || "";
    const previousScroll = scroller.scrollTop;
    const follow = forceFollow || (scroller.scrollHeight - previousScroll - scroller.clientHeight < 55);
    const open = new Set([...transcript.querySelectorAll("details[open]")].map((element) => element.dataset.event));
    const fragment = document.createDocumentFragment();
    if (!s.chain.length) {
      const desc = $("chat-empty-description") ?? empty.querySelector("p");
      desc.textContent = s.setupStatus || (s.authenticated && !s.context?.modelConfigured
        ? (s.context?.mode==="direct" ? "在模型设置中连接 API，开始聊天、操作网页或读取本地文件。" : "请在 Navi 工作台保存并连接 API URL 和 Key。")
        : s.authenticated ? (s.context?.mode==="direct" ? "可以让我操作网页，或通过文件夹按钮连接本地目录。" : canBrowser() ? "可以让我操作网页，需要本地文件时再选择项目。" : s.context?.testing ? "可以指定网址和相对目录，执行当前项目中的测试用例。" : "发送一条消息开始对话，需要本地文件时再选择项目。")
        : "配置模型后即可聊天和操作网页，本机工具按需连接。");
      const cta = empty.querySelector("#show-connections");
      cta.hidden = s.authenticated && s.context?.modelConfigured;
      cta.textContent=s.context?.mode==="direct" ? "设置模型" : "设置连接";
      fragment.append(empty);
    } else {
      for (const item of s.chain) {
        fragment.append(message("user", item.run.prompt || ""));
        let lastReply;
        for (const event of item.events) {
          if (event.type === "model.text" && typeof event.data?.text === "string") {
            lastReply=message("assistant",event.data.text);
            fragment.append(lastReply);
          }
          else if (event.type === "test.report") {
            const card = testReport(event);
            if (card) fragment.append(card);
          }
        }
        const history=operationHistory(item,open);
        if (history) {
          const copy=lastReply?.querySelector(".nv-reply > .nv-copy-icon");
          if (copy) {
            copy.replaceWith(history);
            history.prepend(copy);
            history.classList.add("reply-actions");
          } else fragment.append(history);
        }
      }
      const run = latest().run;
      if (run.pending) fragment.append(approvalCard(run));
      if (run.error) fragment.append(mk("p", "chat-run-error", run.error));
      if (run.uncertain) fragment.append(mk("p", "chat-run-error", "已停止后续工具。请核对浏览器或本机中结果未知的操作。"));
      if (run.status !== "completed") {
      const indicator = mk("span", "nv-status run-status", labels[run.status] || run.status);
      indicator.dataset.tone = run.status === "failed" ? "danger" : run.status === "awaiting_approval" ? "warning" :
        run.status === "completed" ? "success" : "info";
      fragment.append(indicator);
      }
    }
    if (s.authenticated && s.context) {
      if (s.context.mode === "direct") {
        if (!isActive() && (s.showProjectPicker || latest()?.run.needsLocalDirectory && !directoryGranted)) fragment.append(localDirectoryChoice());
      } else if ((s.showProjectPicker || latest()?.run.needsProject) && !s.projectSelected && !isActive()) fragment.append(projectChoice());
      else if (s.projectSelected && s.context.project) fragment.append(mk("p","help","本次对话项目："+s.context.project.name));
    }
    transcript.replaceChildren(fragment);
    scroller.scrollTop = follow ? scroller.scrollHeight : previousScroll;
    syncControls();
  }
  function entry(run) { return { run, events: [], cursor: 0 }; }
  async function collect(item, generation) {
    let changed = false;
    do {
      if (generation !== s.generation) return false;
      const value = await ask("events", { runId: item.run.runId, after: item.cursor });
      if (generation !== s.generation) return false;
      if (!Array.isArray(value.events) || !Number.isSafeInteger(value.next) || value.next < item.cursor ||
        value.run?.runId !== item.run.runId) throw new Error("Navi 返回了无效的会话事件。");
      const nextEvents = value.events.filter((event) => event.seq > item.cursor && event.seq <= value.next);
      if (nextEvents.length || item.run.status !== value.run.status ||
          item.run.pending?.callId !== value.run.pending?.callId) changed = true;
      item.events.push(...nextEvents);
      item.run = value.run;
      if (value.next === item.cursor) break;
      item.cursor = value.next;
    } while (item.cursor < (item.run.lastSeq ?? 0));
    if (changed && item === latest() && item.run.needsLocalDirectory && s.context?.mode === "direct") {
      await refreshDirectory().catch(() => {});
      if (generation === s.generation) s.showProjectPicker = true;
    }
    return changed;
  }
  async function restore(generation, pick = null) {
    const result = await ask("runs");
    if (generation !== s.generation || (!pick && s.chain.length)) return false;
    const runs = Array.isArray(result.runs) ? result.runs : [];
    let next = pick ? pick(runs) : runs.find((run) => !terminal.has(run.status)) ?? runs[0];
    const byId = new Map(runs.map((run) => [run.runId, run]));
    const chain = [];
    const seen = new Set();
    while (next && !seen.has(next.runId) && chain.length < 30) {
      seen.add(next.runId);
      chain.unshift(entry(next));
      next = byId.get(next.previousRunId);
    }
    if (!chain.length) return false;
    s.chain = chain;
    s.projectSelected=latest().run.projectSelected===true;
    s.showProjectPicker=false;
    s.model = latest().run.model;
    s.effort = latest().run.reasoningEffort || "";
    renderContext();
    renderTranscript(true);
    await Promise.all(chain.map((item) => collect(item, generation)));
    if (generation === s.generation) renderTranscript(true);
    return true;
  }
  async function recoverCreate(generation, searchedByUser = false) {
    const attempt = s.uncertainCreate;
    if (!attempt || !s.authenticated) return;
    const alreadyShown = new Set(s.chain.map(({ run }) => run.runId));
    try {
      const found = await restore(generation, (runs) => runs.find((run) => !terminal.has(run.status)) ??
        runs.find((run) => !alreadyShown.has(run.runId) && run.prompt === attempt.prompt &&
          run.model === attempt.model && run.startedAt >= attempt.startedAt - 2000));
      if (generation !== s.generation) return;
      if (found) {
        s.uncertainCreate = null;
        if (latest().run.prompt === attempt.prompt && $("chat-prompt").value === attempt.draft) $("chat-prompt").value = "";
        status(s.context?.mode==="direct" ? "已恢复独立对话。" : "已恢复工作台报告的运行。");
      } else if (searchedByUser) {
        s.uncertainCreate = null;
        status("没有找到新的运行；草稿已保留。");
      } else {
        status("发送结果未确认。请检查运行状态；草稿已保留。", true);
      }
    } catch (error) {
      if (generation !== s.generation) return;
      if (error.code === "BRIDGE_RECONNECT") handleError(error);
      else status("暂时无法检查运行状态。请重试；草稿已保留。", true);
    } finally { syncControls(); }
  }
  async function context() {
    if (s.checking || !s.connection?.chatConnected) return;
    s.checking = true;
    const requested = s.connection;
    try {
      const info = await ask("context");
      if (requested.connectionId !== s.connection?.connectionId) return;
      if ((info.mode!=="direct" && !info.project) || !Array.isArray(info.models)) throw new Error("Navi 返回的项目或模型无效。");
      const renew = !s.context || info.mode!==s.context.mode || info.connectionId!==s.context.connectionId || info.expiresAt !== s.context.expiresAt || info.project?.id !== s.context.project?.id;
      const recovered = !s.authenticated;
      s.authenticated = true;
      s.reconnectRequired = false;
      s.setupStatus = "";
      s.context = info;
      if (renew) {
        ++s.generation;
        screenshots.clear();
        s.chain = [];
        s.uncertainCreate = null;
        s.model = "";
        s.effort = "";
        s.projectSelected=false; s.showProjectPicker=false;
      }
      if (renew || recovered) status("");
      const directoryChanged = info.mode === "direct" && !s.busy && await refreshDirectory().catch(() => false);
      if (!info.capabilities?.projectSelection) status("工作台仍是旧版本。请停止旧 Navi 后重新启动；仅刷新页面或再次双击启动器不会更新正在运行的服务。",true);
      renderContext();
      if (renew || recovered || directoryChanged || !s.chain.length) renderTranscript();
      if (renew || (recovered && !s.chain.length)) await restore(s.generation);
    } catch (error) { handleError(error); }
    finally {
      s.checking = false;
      if (requested.connectionId !== s.connection?.connectionId && s.connection?.chatConnected) void context();
    }
  }
  async function poll() {
    if (!s.authenticated || !isActive() || s.runningPoll || s.busy || s.checking) return;
    s.runningPoll = true;
    const generation = s.generation;
    try {
      if (await collect(latest(), generation) && generation === s.generation) renderTranscript();
    } catch (error) { if (generation === s.generation) handleError(error); }
    finally { s.runningPoll = false; }
  }
  async function act(kind, args) {
    if (s.busy || !s.authenticated) return;
    s.busy = true;
    syncControls();
    const generation = s.generation;
    try {
      const run = await ask(kind, args);
      if (generation === s.generation && latest()?.run.runId === run.runId) {
        latest().run = run;
        status("");
        await collect(latest(), generation);
      }
    } catch (error) { if (generation === s.generation) handleError(error); }
    finally { s.busy = false; renderTranscript(); }
  }
  async function submitPrompt(draft) {
    const input = $("chat-prompt");
    if (!eligible() || s.busy || isActive() || s.uncertainCreate || !draft.trim()) return;
    if(s.context.mode!=="direct" && !canBrowser() && NaviIntent.browserAction(draft)) {
      const explanation='当前本机连接未授权网页操作，本轮尚未发送。可切换到独立模式配置模型，或重新连接 Navi 并单独勾选「允许浏览器操作」，无需授权本机文件操作。';
      status(explanation,true);
      $("feedback").textContent=explanation; $("feedback").dataset.error="true";
      discloseConnection();
      $("local-settings").open=true;
      return;
    }
    const attempt = { draft, prompt: draft.trim(), model: s.model, startedAt: Date.now(), clientRequestId: crypto.randomUUID() };
    const last = latest()?.run;
    const directoryId = s.context.mode === "direct" && directoryGranted ? localDirectory.id : null;
    const sameDirectory = s.context.mode !== "direct" || (last?.directoryId ?? null) === directoryId;
    const previousRunId = last?.status === "completed" && last.model === s.model && sameDirectory ? last.runId : undefined;
    const generation = s.generation;
    s.busy = true;
    syncControls();
    try {
      const run = await ask("create", { prompt: draft, model: s.model, ...(s.context.mode==="direct" ? {directoryId, ...(s.effort ? {reasoningEffort:s.effort} : {})} : {}), previousRunId, clientRequestId: attempt.clientRequestId, projectSelected:s.projectSelected });
      if (generation !== s.generation) return;
      if (typeof run?.runId !== "string" || run.projectId !== (s.context.project?.id ?? null)) {
        throw new Error("Navi 未返回有效的运行记录。");
      }
      if (!previousRunId) s.chain = [];
      const item = entry(run);
      s.chain.push(item);
      if (input.value === draft) input.value = "";
      status("");
      renderTranscript(true);
      if (await collect(item, generation) && generation === s.generation) renderTranscript();
    } catch (error) {
      if (generation !== s.generation) return;
      if (error.code === "DIRECTORY_PERMISSION") {
        await refreshDirectory().catch(() => {});
        s.showProjectPicker = true;
        renderTranscript(true);
        handleError(error);
      } else if (!error.code || ["BRIDGE_UNAVAILABLE", "BRIDGE_CONFLICT"].includes(error.code)) {
        s.uncertainCreate = attempt;
        await recoverCreate(generation);
      } else handleError(error);
    } finally { s.busy = false; syncControls(); }
  }
  $("composer").addEventListener("submit",event=>{event.preventDefault();if(event.isTrusted)void submitPrompt($("chat-prompt").value);});
  $("recover-chat").addEventListener("click", async (event) => {
    if (!event.isTrusted || s.busy) return;
    s.busy = true;
    syncControls();
    try { await recoverCreate(s.generation, true); }
    finally { s.busy = false; syncControls(); }
  });
  $("chat-prompt").addEventListener("input", syncControls);
  $("chat-prompt").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!$("send-chat").disabled) $("composer").requestSubmit($("send-chat"));
  });
  $("show-connections").addEventListener("click", discloseConnection);
  $("open-settings").addEventListener("click", discloseConnection);
  $("close-settings").addEventListener("click", () => $("bridge-settings").close());
  $("bridge-settings").addEventListener("click", event => {
    if (event.target !== $("bridge-settings")) return;
    const box = event.target.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close();
  });
  $("choose-project").addEventListener("click",event=>{
    if (!event.isTrusted || $("choose-project").disabled) return;
    if (s.projectSelected && s.chain.length) { status("切换项目请先开始新对话。"); return; }
    s.showProjectPicker=!s.showProjectPicker; renderTranscript(true);
  });
  $("chat-model").addEventListener("change", () => {
    s.model = $("chat-model").value;
    s.effort = "";
    renderEffort();
    syncControls();
  });
  $("chat-effort").addEventListener("change", () => { s.effort = $("chat-effort").value; });
  $("stop-chat").addEventListener("click", (event) => {
    if (event.isTrusted && isActive()) void act("cancel", { runId: latest().run.runId });
  });
  $("new-chat").addEventListener("click", (event) => {
    if (!event.isTrusted || s.busy || s.authenticated && isActive()) return;
    ++s.generation;
    screenshots.clear();
    s.chain = [];
    s.projectSelected=false; s.showProjectPicker=false;
    $("chat-prompt").value = "";
    renderTranscript(true);
    if (eligible()) $("chat-prompt").focus();
  });
  $("disconnect-chat").addEventListener("click", async (event) => {
    if (!event.isTrusted || s.busy || !s.authenticated) return;
    s.busy = true;
    syncControls();
    try {
      await ask("disconnect");
      ++s.generation;
      screenshots.clear();
      s.authenticated = false;
      s.context = null;
      s.connection = { ...s.connection, chatConnected: false };
      s.chain = [];
      s.uncertainCreate = null;
      status("侧栏会话已断开，可重新连接 Navi。");
      renderContext();
    } catch (error) { handleError(error); }
    finally { s.busy = false; renderTranscript(); }
  });
  document.addEventListener("navi-link-connection", ({ detail }) => {
    const previous = s.connection;
    s.connection = detail;
    if (previous && (previous.connectionId!==detail.connectionId || previous.chatMode!==detail.chatMode)) {
      ++s.generation;
      screenshots.clear();
      s.authenticated = false;
      s.context = null;
      s.chain = [];
      s.uncertainCreate = null;
    }
    if (detail.chatConnected) void context();
    else {
      s.authenticated = false;
      s.setupStatus = detail.paired ? "请重新连接 Navi 以启用侧栏对话。" : "";
      renderContext();
      renderTranscript();
    }
  });
  setInterval(() => void poll(), 700);
  setInterval(() => { if (!s.reconnectRequired) void context(); }, 15_000);
})();
