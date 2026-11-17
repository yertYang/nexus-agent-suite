// SPDX-License-Identifier: GPL-3.0-only
(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  let tabId;
  let settings;
  let state;
  let busy = false;
  let configBusy = false;
  let pairPolling = false;
  const configButtons = ["pair", "pair-refresh", "save", "check", "clear", "save-tools", "copy-protocol"];
  const labels = {
    pending: "等待你确认", running: "等待本机 Nexus 响应",
    success: "Nexus 已完成", error: "Nexus 返回错误",
    approval: "等待 Nexus 审批", rejected: "已拒绝",
    expired: "待确认请求已过期", cancelled: "已停止等待",
    interrupted: "浏览器中断了等待",
  };

  async function ask(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw new Error(response?.error ?? "扩展未响应。");
    return response.data;
  }
  function note(message, error = false) {
    el("feedback").textContent = message;
    el("feedback").dataset.error = String(error);
  }
  function renderSettings(data) {
    const previousMode = settings?.chatMode;
    settings = data;
    document.dispatchEvent(new CustomEvent("navi-link-connection", { detail: {
      projectId: data.projectId, chatMode:data.chatMode, connectionId:data.connectionId,directConfigured:data.direct?.configured, paired: data.paired, pairState: data.pairState, chatConnected: data.chatConnected,
    } }));
    el("chat-mode").value=data.chatMode || "direct";
    el("direct-settings").hidden=data.chatMode==="navi";
    el("navi-mode-help").hidden=data.chatMode!=="navi";
    if (document.activeElement!==el("direct-url")) el("direct-url").value=data.direct?.baseUrl || "";
    el("direct-key-state").textContent=data.direct?.configured ? "已保存" : "未设置";
    el("direct-clear").disabled=!data.direct?.configured;
    if ((previousMode !== data.chatMode && data.chatMode === "navi") || data.pairState === "pending" || (!previousMode && data.configured)) el("local-settings").open = true;
    el("project").value = data.projectId;
    el("project").readOnly = data.paired;
    el("configured").textContent = data.expired ? "已过期" : data.configured ? "已保存" : "未设置";
    el("clear").disabled = !data.configured && !data.paired;
    const catalogue = el("catalogue");
    catalogue.replaceChildren();
    for (const tool of data.catalogue) {
      const label = document.createElement("label");
      label.className = "tool-label";
      label.title = tool.description;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = tool.name;
      input.checked = data.selected.includes(tool.name);
      label.append(input, tool.name);
      catalogue.append(label);
    }
    el("tools").hidden = data.catalogue.length === 0;
    el("connection-status").textContent = data.version ?
      "已连接 · MCP " + data.version + " · 可选工具 " + data.catalogue.length :
      (data.selected.length ? "已启用 " + data.selected.length + " 个工具。检测连接可重新加载工具列表。" : "");
    const pending = data.pairState === "pending";
    const ready = data.configured && data.selected.length > 0 && !!data.projectId;
    const tagline = pending ? "待确认" : data.expired ? "已过期" : data.paired ? "已连接 · 只读" : data.configured ? "手动连接" : "";
    const tag = el("pair-tag");
    tag.textContent = tagline;
    tag.dataset.tone = pending || data.expired ? "warning" : data.paired ? "success" : "neutral";
    el("pair").textContent = pending ? "打开确认页" : data.expired ? "重新连接 Navi" : data.paired ? "更换项目" : "连接 Navi";
    const messages = {
      pending: "请在 Navi 选择项目并确认。完成后回到此侧栏即可，不用复制令牌。",
      denied: "Navi 已拒绝这次连接。可重新发起请求。",
      expired: "配对请求已过期，请重新连接 Navi。",
      consumed: "此次请求已使用，请重新连接 Navi。",
    };
    el("pair-status").textContent = messages[data.pairState] ?? (data.expired
      ? "项目「" + data.projectName + "」的只读连接已到期，请重新连接。"
      : data.paired
        ? "已连接项目「" + data.projectName + "」。" + (data.selectionPending
          ? "暂时未能加载只读工具，可重试。" : "每次执行仍需你在这里确认。")
        : data.configured
          ? "正在使用高级设置中的手动连接。也可以通过 Navi 选择项目。"
          : "在 Navi 中选择一个项目，网页工具将默认使用只读权限。");
    el("pair-refresh").hidden = !data.paired || !data.configured || !data.selectionPending;
    el("copy-protocol").hidden = !ready;
    el("copy-protocol").disabled = !ready || pending;
  }
  function renderState(next) {
    state = next;
    const entry = state.entry;
    el("review").hidden = !entry;
    if (!entry) return;
    el("tool-name").textContent = entry.tool;
    const rounds = el("rounds");
    rounds.textContent = state.rounds + "/" + state.max + " 轮" + (!state.armed ? " · 已暂停" : "");
    rounds.dataset.tone = !state.armed ? "warning" : "info";
    el("call-state").textContent = (labels[entry.status] ?? entry.status) +
      (entry.modelId ? " · " + entry.modelId : "");
    el("args").textContent = JSON.stringify(entry.arguments, null, 2);
    el("noAuto").hidden = entry.status !== "pending";
    el("pending-note").hidden = entry.status !== "approval";
    el("pending-note").textContent = (entry.approval?.id ? "审批 ID：" + entry.approval.id + "。 " : "") +
      "审批后可在这里重新提交原工具请求。";
    const approval = el("approvals");
    const url = entry.approval?.url;
    approval.hidden = entry.status !== "approval" || typeof url !== "string" ||
      !/^http:\/\/127\.0\.0\.1:17880\/#approvals(?:\?approvalId=approval_[0-9a-f-]{36})?$/i.test(url);
    if (approval.hidden) approval.removeAttribute("href");
    else approval.href = url;
    el("result").textContent = entry.text ?? "";
    el("result").hidden = !entry.text;
    el("copy-result").hidden = !entry.text || !["success", "error"].includes(entry.status);
    const option = {
      execute: state.armed && entry.status === "pending",
      reject: entry.status === "pending",
      retry: state.armed && entry.status === "approval" && !!entry.approval?.id && !entry.retryUsed,
      cancel: entry.status === "running",
    };
    for (const [id, visible] of Object.entries(option)) {
      el(id).hidden = !visible;
      el(id).disabled = id !== "cancel" && busy;
    }
  }
  async function inspect() {
    const target = tabId;
    const next = await ask("popup.inspect", { tabId: target });
    if (target === tabId && next !== null) renderState(next);
  }
  function bind(id, fn) {
    el(id).addEventListener("click", (event) => {
      if (event.isTrusted) void fn().catch((error) => note(error.message, true));
    });
  }
  function configAction(id, fn) {
    bind(id, async () => {
      if (configBusy) return;
      configBusy = true;
      for (const button of configButtons) el(button).disabled = true;
      el(id).setAttribute("aria-busy", "true");
      el("feedback").textContent = "";
      try { await fn(); }
      finally {
        configBusy = false;
        el(id).removeAttribute("aria-busy");
        for (const button of configButtons) el(button).disabled = false;
        if (settings) {
          el("clear").disabled = !settings.configured && !settings.paired;
          el("copy-protocol").disabled = !settings.selected.length || !settings.projectId ||
            !settings.configured || settings.pairState === "pending";
        }
      }
    });
  }

  bind("direct-save",async()=>{
    if (configBusy) return;
    const baseUrl=el("direct-url").value.trim(),key=el("direct-key").value;
    let url;try {url=new URL(baseUrl);}catch{throw new Error("请输入有效模型地址。");}
    if (!["https:","http:"].includes(url.protocol)) throw new Error("模型地址需使用 HTTP 或 HTTPS。");
    const permission=chrome.permissions.request({origins:[url.origin+"/*"]});
    configBusy=true;el("direct-save").disabled=true;el("direct-status").textContent="正在验证模型连接…";
    try {
      if (!(await permission)) throw new Error("尚未允许访问模型服务。");
      const next=await ask("popup.direct.save",{baseUrl,key});
      el("direct-key").value="";renderSettings(next);el("direct-status").textContent="已连接，可在输入区选择模型。";
    } catch(error) {el("direct-status").textContent=key?error.message.split(key).join("[已隐藏密钥]"):error.message;}
    finally {configBusy=false;el("direct-save").disabled=false;}
  });
  bind("direct-clear",async()=>{renderSettings(await ask("popup.direct.clear"));el("direct-key").value="";el("direct-status").textContent="模型配置已移除。";});
  el("chat-mode").addEventListener("change",async event=>{
    if (!event.isTrusted) return;
    try {renderSettings(await ask("popup.chat.mode",{mode:el("chat-mode").value}));}
    catch(error){note(error.message,true);if(settings)el("chat-mode").value=settings.chatMode;}
  });

  configAction("pair", async () => {
    renderSettings(await ask("popup.pair.start"));
  });
  async function pollPair() {
    if (pairPolling || configBusy || settings?.pairState !== "pending") return;
    pairPolling = true;
    try {
      const next = await ask("popup.pair.status");
      renderSettings(next);
      if (next.pairState === "connected") note("配对成功，已启用此项目的只读工具。");
      if (next.pairState === "tools-unavailable") note("已连接 Navi。还需从本机 Nexus 加载只读工具。");
    } catch (error) {
      note(error.message, true);
    } finally {
      pairPolling = false;
    }
  }

  configAction("save", async () => {
    const token = el("token").value;
    el("token").value = "";
    renderSettings(await ask("popup.save", { token, projectId: el("project").value }));
    note("已保存。点击「检测连接」加载工具。");
    await inspect();
  });
  configAction("clear", async () => {
    el("token").value = "";
    renderSettings(await ask("popup.save", { clear: true }));
    el("prompt").hidden = true;
    el("prompt").value = "";
    note("已清除本机扩展的连接。");
    await inspect();
  });
  async function checkTools() {
    el("connection-status").textContent = "正在读取 Nexus 工具列表…";
    try { renderSettings(await ask("popup.check")); note("MCP 连接正常。"); }
    catch (error) { el("connection-status").textContent = ""; throw error; }
  }
  configAction("check", checkTools);
  configAction("pair-refresh", checkTools);
  configAction("save-tools", async () => {
    const selected = [...el("catalogue").querySelectorAll("input:checked")].map((input) => input.value);
    renderSettings(await ask("popup.save", { projectId: el("project").value, selected }));
    el("prompt").hidden = true;
    el("prompt").value = "";
    note(settings.selected.length ? "已保存 " + settings.selected.length + " 个工具。" : "尚未启用任何工具。");
    await inspect();
  });
  configAction("copy-protocol", async () => {
    const { prompt } = await ask("popup.protocol");
    const input = el("prompt");
    input.hidden = false;
    input.value = prompt;
    try {
      await navigator.clipboard.writeText(prompt);
      note("已复制协议。请粘贴到网页会话，再由你发送。");
    } catch {
      input.select();
      if (document.execCommand("copy")) note("已复制协议。请粘贴到网页会话，再由你发送。");
      else note("浏览器没有授权自动复制。已选中协议，请按 Ctrl/⌘ + C。");
    }
  });
  bind("copy-result", async () => {
    const text = state?.entry?.text;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); note("已复制结果。"); }
    catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el("result"));
      selection.removeAllRanges();
      selection.addRange(range);
      note(document.execCommand("copy") ? "已复制结果。" : "已选中结果，请按 Ctrl/⌘ + C。");
    }
  });
  for (const action of ["execute", "retry", "reject", "cancel"]) {
    bind(action, async () => {
      if (!state?.entry || (busy && action !== "cancel")) return;
      const pendingId = state.entry.id;
      const target = tabId;
      if (action !== "cancel") busy = true;
      renderState(state);
      note("");
      try {
        const next = await ask("popup." + action, { tabId: target, pendingId });
        if (target === tabId) renderState(next);
      } finally {
        if (action !== "cancel") busy = false;
        if (state) renderState(state);
      }
    });
  }

  (async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0]?.id;
    const windowId = tabs[0]?.windowId;
    chrome.tabs.onActivated.addListener((active) => {
      if (active.windowId !== windowId) return;
      tabId = active.tabId;
      state = null;
      el("review").hidden = true;
      void inspect().catch(() => {});
    });
    renderSettings(await ask("popup.config"));
    await inspect();
    void pollPair();
    setInterval(() => void pollPair(), 1600);
    setInterval(() => void inspect().catch(() => {}), 650);
  })().catch((error) => note(error.message, true));
})();
