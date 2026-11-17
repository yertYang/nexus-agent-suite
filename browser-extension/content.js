// SPDX-License-Identifier: GPL-3.0-only
(() => {
  "use strict";

  const P = globalThis.NexusProtocol;
  const D = globalThis.NexusPage;
  if (window.top !== window || !P.siteUrl(location.href)) return;
  const adapter = D.openAdapter(document, location.hostname);
  const host = document.createElement("div");
  host.id = "nexus-web-bridge";
  const root = host.attachShadow({ mode: "closed" });
  function make(tag, { id, text, hidden, ...attrs } = {}, parent) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    if (text) node.textContent = text;
    if (hidden) node.hidden = true;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent.append(node);
    return node;
  }
  const css = `
      :host { all:initial; position:fixed; right:18px; bottom:96px; z-index:2147483600;
        font:13px/1.5 system-ui,sans-serif; color:#222; }
      * { box-sizing:border-box; }
      [hidden] { display:none!important; }
      button,a { font:inherit; }
      button { cursor:pointer; color:#202020; background:#f5f5f5; border:1px solid #d7d7d7;
        border-radius:8px; padding:7px 10px; }
      button:hover { background:#eaeaea; }
      button:disabled { opacity:.45; cursor:default; }
      button:focus-visible,a:focus-visible { outline:2px solid #536f8b; outline-offset:2px; }
      #toggle { margin-left:auto; display:block; border:0; background:#536f8b; color:#fff;
        border-radius:20px; font-weight:640; padding:6px 12px 6px 7px; box-shadow:0 2px 9px #0003; }
      #toggle:hover { background:#455e76; }
      #toggle svg { width:20px; height:20px; margin-right:4px; vertical-align:middle; }
      #label { vertical-align:middle; }
      #pane { width:min(320px,calc(100vw - 40px)); background:#fff; border:1px solid #dedede;
        border-radius:12px; padding:12px; margin-bottom:8px; box-shadow:0 8px 36px #0003; }
      strong { display:block; font-size:15px; }
      #status { min-height:36px; margin:7px 0; overflow-wrap:anywhere; white-space:pre-wrap; }
      #rounds { color:#555; font-size:11px; margin-top:6px; }
      .actions { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
      a { color:#222; }
`;
  make("style", { text: css }, root);
  const pane = make("section", { id: "pane", hidden: true, "aria-label": "Navi Link" }, root);
  make("strong", { text: "Navi Link" }, pane);
  make("div", { id: "status", role: "status" }, pane);
  const actions = make("div", { class: "actions" }, pane);
  for (const [id, text] of [
    ["arm", "启用当前对话"], ["stop", "停止监听"],
    ["review", "打开扩展确认"], ["insert", "追加到草稿"],
  ]) make("button", { id, text, hidden: id !== "arm", type: "button" }, actions);
  make("a", { id: "approval", text: "打开本机审批", hidden: true,
    target: "_blank", rel: "noopener noreferrer" }, actions);
  make("div", { id: "rounds" }, pane);
  const toggle = make("button", { id: "toggle", type: "button",
    "aria-expanded": "false", "aria-controls": "pane" }, root);
  // Match the toolbar mark without exposing extension assets to web pages.
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const strokes = document.createElementNS(namespace, "path");
  strokes.setAttribute("d", "M7 16.8V7.2l10 9.6V7.2");
  strokes.setAttribute("fill", "none");
  strokes.setAttribute("stroke", "#fff");
  strokes.setAttribute("stroke-width", "2.4");
  strokes.setAttribute("stroke-linecap", "round");
  strokes.setAttribute("stroke-linejoin", "round");
  icon.append(strokes);
  toggle.append(icon);
  make("span", { id: "label", text: "Navi Link · 未启用" }, toggle);
  (document.body ?? document.documentElement).append(host);
  const element = (id) => root.getElementById(id);
  let route = P.siteUrl(location.href);
  let lease = null;
  let turn = null;
  let marked = null;
  let candidate = null;
  let advance = null;
  let generation = 0;
  let scanning = false;
  let busy = false;
  let state = null;
  let lastPoll = 0;
  let lastIntent = 0;
  let lastHint = "";
  let consumed = new Set();

  function show(hint = "") {
    if (hint) lastHint = hint;
    const entry = state?.entry;
    const statuses = {
      pending: "等待你在扩展侧栏确认：",
      running: "正在等待 Nexus：",
      success: "工具已完成。请先在扩展侧栏查看结果，再按需追加到草稿：",
      error: "工具返回错误。可在扩展侧栏查看错误，或将其追加到草稿：",
      approval: "Nexus 要求另行审批。请在工作台或 Nexus Desktop 处理：",
      cancelled: "已停止等待。请核对 Nexus 是否收到请求：",
      expired: "待确认请求已过期：",
      rejected: "你已拒绝此请求：",
      interrupted: "浏览器中断了等待。请核对 Nexus 是否收到请求：",
    };
    let description = lastHint;
    if (!description && entry) {
      description = (statuses[entry.status] ?? "") + entry.tool;
      if (entry.status === "approval" && entry.approval?.id) description += "\n" + entry.approval.id;
      if (entry.consumed || consumed.has(entry.id)) description = "结果已追加到草稿。请检查内容，再自行发送。";
    }
    if (!description) description = lease
      ? "请在 " + adapter.name + " 发送下一条消息。只检查这条消息之后新增的完整回复。"
      : "请先在扩展侧栏连接 Navi 并选择项目。启用后，从你下一次发送的消息开始检查。";
    element("status").textContent = description;
    element("label").textContent = entry?.status === "pending" ? "Navi Link · 待确认" : lease ? "Navi Link · 已启用" : "Navi Link · 未启用";
    element("arm").hidden = Boolean(lease && state?.armed);
    element("stop").hidden = !lease;
    element("arm").disabled = busy;
    element("stop").disabled = busy;
    element("review").hidden = !entry || !["pending", "running", "success", "error"].includes(entry.status);
    element("insert").hidden = !entry || !["success", "error"].includes(entry.status) ||
      Boolean(entry.consumed || consumed.has(entry.id));
    element("insert").disabled = busy;
    const approvalUrl = entry?.approval?.url;
    element("approval").hidden = !(entry?.status === "approval" &&
      typeof approvalUrl === "string" && (approvalUrl === P.APPROVALS_URL || approvalUrl.startsWith(P.APPROVALS_URL + "?approvalId=")));
    if (!element("approval").hidden) element("approval").href = approvalUrl;
    else element("approval").removeAttribute("href");
    element("rounds").textContent = lease ? ("调用：" + (state?.rounds ?? 0) + "/" +
      P.MAX_ROUNDS + " · 逐次确认 · 手动发送" + (!state?.armed ? " · 已暂停" : "")) : "";
  }

  async function ask(type, extra = {}, saved = { route, lease }) {
    const response = await chrome.runtime.sendMessage({
      type, route: saved.route, lease: saved.lease, ...extra,
    });
    if (!response?.ok) throw new Error(response?.error ?? "扩展未响应。");
    return response.data;
  }
  function sameTime(stamp) {
    return stamp === generation && route === P.siteUrl(location.href);
  }

  function clearForNavigation() {
    const current = P.siteUrl(location.href);
    if (current === route) return false;
    // The worker independently invalidates the tab on navigation. In this
    // document we also drop every page-local reference before handling DOM.
    route = current;
    lease = null;
    turn = null;
    marked = null;
    candidate = null;
    advance = null;
    state = null;
    busy = false;
    generation++;
    consumed = new Set();
    show("已切换页面。需要监听时，请在当前对话重新启用。");
    return true;
  }

  function setState(next) {
    state = next;
    lastHint = next.notice ?? "";
    if (state?.entry?.status === "pending") {
      element("pane").hidden = false;
      element("toggle").setAttribute("aria-expanded", "true");
    }
    show();
  }

  function bind(id, handler) {
    element(id).addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      void Promise.resolve(handler()).catch((error) => show(error.message));
    });
  }

  bind("toggle", () => {
    element("pane").hidden = !element("pane").hidden;
    element("toggle").setAttribute("aria-expanded", String(!element("pane").hidden));
  });
  bind("arm", async () => {
    clearForNavigation();
    if (busy) return;
    const stamp = ++generation;
    busy = true;
    show();
    try {
      const next = await ask("page.arm");
      if (!sameTime(stamp)) return;
      lease = next.lease;
      turn = null;
      candidate = null;
      marked = null;
      consumed = new Set();
      setState(next);
    } catch (error) {
      if (sameTime(stamp)) show(error.message);
    } finally {
      if (sameTime(stamp)) { busy = false; show(); }
    }
  });
  bind("stop", async () => {
    clearForNavigation();
    if (!lease) return;
    const saved = { route, lease };
    ++generation;
    lease = null;
    turn = null;
    marked = null;
    candidate = null;
    advance = null;
    state = null;
    busy = false;
    show("已停止监听。已发送的工具请求可能仍在 Nexus 中执行。");
    try { await ask("page.stop", {}, saved); } catch {}
  });
  bind("review", async () => {
    if (clearForNavigation() || !lease) return;
    show("请在浏览器工具栏打开 Navi Link，检查请求参数。");
    await ask("page.open-panel");
  });
  bind("insert", async () => {
    if (clearForNavigation() || !lease || busy || !candidate) return;
    const entry = state?.entry;
    if (!entry || entry.key !== candidate.key || consumed.has(entry.id)) return;
    const stamp = generation;
    busy = true;
    show();
    try {
      const { text } = await ask("page.result", { pendingId: entry.id });
      if (!sameTime(stamp) || !await stillCurrent(candidate?.key) || !sameTime(stamp)) return;
      if (adapter.generating(candidate.node)) throw new Error("请等网页回复完成后再追加。");
      if (!D.appendDraft(adapter.composer(), text, () => sameTime(stamp))) throw new Error("无法写入当前输入框，请在扩展侧栏复制结果。");
      consumed.add(entry.id);
      show("结果已追加到草稿。请检查内容，再自行发送。");
      try { await ask("page.consumed", { pendingId: entry.id }); } catch {}
    } catch (error) {
      if (sameTime(stamp)) show(error.message);
    } finally {
      if (sameTime(stamp)) { busy = false; show(); }
    }
  });

  function userSent() {
    if (clearForNavigation() || !lease || !state?.armed || busy || Date.now() - lastIntent < 350) return;
    const input = adapter.composer();
    const draft = D.draftValue(input);
    const tracker = new D.TurnTracker(adapter);
    if (!tracker.userIntent(draft)) return;
    lastIntent = Date.now();
    const stamp = ++generation;
    marked = null;
    candidate = null;
    turn = { tracker, id: crypto.randomUUID(), stamp };
    advance = ask("page.advance").then((next) => {
      if (sameTime(stamp)) setState(next);
    }).catch((error) => {
      if (sameTime(stamp)) {
        turn = null;
        show(error.message);
      }
    }).finally(() => {
      if (sameTime(stamp)) advance = null;
    });
  }
  document.addEventListener("keydown", (event) => {
    const input = adapter.composer();
    if (event.isTrusted && input?.contains(event.target) && event.key === "Enter" && !event.shiftKey &&
      !event.altKey && !event.isComposing && event.keyCode !== 229 && !event.repeat) userSent();
  }, true);
  document.addEventListener("click", (event) => {
    if (event.isTrusted && adapter.sendControl(event.target)) userSent();
  }, true);
  document.addEventListener("submit", (event) => {
    const input = adapter.composer();
    if (event.isTrusted && input && event.target.contains(input)) userSent();
  }, true);

  async function stillCurrent(key) {
    if (!candidate || candidate.key !== key || !turn || !sameTime(turn.stamp)) return false;
    const reply = turn.tracker.current();
    if (!reply || reply !== candidate.node || adapter.generating(reply)) return false;
    try {
      const call = D.callFromMessage(reply);
      return !!call && P.canonical(call.value) === candidate.canonical;
    } catch {
      return false;
    }
  }

  async function scan() {
    if (clearForNavigation() || !lease || scanning) return;
    scanning = true;
    try {
      const stamp = generation;
      if (candidate && Date.now() - lastPoll > 1150) {
        lastPoll = Date.now();
        const latest = await ask("page.state");
        if (!sameTime(stamp)) return;
        if (latest.entry?.status !== state?.entry?.status || latest.armed !== state?.armed ||
          latest.entry?.consumed !== state?.entry?.consumed) setState(latest);
      }
      if (!sameTime(stamp) || !turn || advance || candidate || !state?.armed) return;
      const node = turn.tracker.current();
      if (!node || adapter.generating(node)) { marked = null; return; }
      const rendered = node.textContent;
      const now = Date.now();
      if (marked?.node !== node || marked.rendered !== rendered) {
        marked = { node, rendered, since: now, tried: false };
        return;
      }
      if (marked.tried || now - marked.since < 1150) return;
      marked.tried = true;
      let call;
      try { call = D.callFromMessage(node); }
      catch (error) { show(error.message); return; }
      if (!call) return;
      const canonical = P.canonical(call.value);
      const key = await P.hash(P.canonical([route, D.messageId(node) ?? turn.id,
        call.value.tool, call.value.arguments]));
      if (!sameTime(stamp) || turn.tracker.current() !== node || node.textContent !== rendered) return;
      candidate = { node, canonical, key };
      try {
        const next = await ask("page.stage", { key, source: call.source });
        if (sameTime(stamp)) setState(next);
      } catch (error) {
        if (sameTime(stamp)) {
          candidate = null;
          show(error.message);
        }
      }
    } catch (error) {
      generation++;
      lease = null;
      turn = null;
      candidate = null;
      state = null;
      show(error.message);
    } finally {
      scanning = false;
    }
  }

  // Site navigations and React renders are checked even when no MCP request is
  // pending. A single bounded interval avoids observing individual stream tokens.
  setInterval(() => void scan(), 350);
  window.addEventListener("popstate", clearForNavigation);
  window.addEventListener("hashchange", clearForNavigation);
  window.addEventListener("pageshow", clearForNavigation);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "worker.verify" || sender.id !== chrome.runtime.id || sender.tab) return false;
    if (clearForNavigation() || message.route !== route || message.lease !== lease) {
      sendResponse({ valid: false });
      return false;
    }
    void stillCurrent(message.key).then((valid) => sendResponse({ valid }), () => sendResponse({ valid: false }));
    return true;
  });

  show();
})();
