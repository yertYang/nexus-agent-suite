// SPDX-License-Identifier: GPL-3.0-only
// Platform DOM adapters inspired by WebAgent 1.3.3 (ysunyang4/webagent).
(() => {
  "use strict";

  const P = globalThis.NexusProtocol;
  const REASONING = "details, [data-message-content-type='reasoning'], [data-testid*='reasoning'], " +
    ".ds-think-content, [class*='thought'], [class*='think-content'], [class*='reasoning']";
  const HIDDEN = "[hidden], [aria-hidden='true'], nav, aside, header, footer, form, [contenteditable='true']";
  const DEEPSEEK_USER = ".ds-message--user, .ds-user-message, [class*='user-message'], " +
    "[data-role='user'], [data-message-author-role='user'], .fbb737a4";
  const DEEPSEEK_ASSISTANT = "[data-role='assistant'], [data-message-author-role='assistant'], " +
    ".ds-assistant-message-main-content, [class*='ds-assistant-message'], " +
    ".ds-message:not(.ds-message--user):has(.ds-markdown), .ds-markdown";
  const CHATGPT_USER = "[data-message-author-role='user']";
  const CHATGPT_ASSISTANT = "[data-message-author-role='assistant']";

  function normalized(text) {
    return (text ?? "").replace(/\s+/g, " ").trim();
  }
  function roots(doc, selector, excludes = "") {
    const matches = Array.from(doc.querySelectorAll(selector)).filter((node) =>
      !node.closest(HIDDEN) && (!excludes || !node.closest(excludes)));
    const found = new Set(matches);
    return matches.filter((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (found.has(parent)) return false;
      }
      return true;
    });
  }
  function messageId(node) {
    const named = node.closest("[data-message-id], [data-turn-id], [data-message-key]");
    if (!named) return null;
    return named.dataset.messageId || named.dataset.turnId || named.dataset.messageKey || null;
  }
  function textOf(node) {
    return node.innerText ?? node.textContent ?? "";
  }
  function openAdapter(doc, hostname) {
    const deepSeek = hostname === "chat.deepseek.com";
    return {
      name: deepSeek ? "DeepSeek" : "ChatGPT",
      users: () => roots(doc, deepSeek ? DEEPSEEK_USER : CHATGPT_USER),
      assistants: () => roots(doc, deepSeek ? DEEPSEEK_ASSISTANT : CHATGPT_ASSISTANT,
        deepSeek ? DEEPSEEK_USER + ", " + REASONING : REASONING),
      composer: () => deepSeek
        ? doc.querySelector("textarea#chat-input, textarea[placeholder*='DeepSeek' i], " +
          "textarea[placeholder*='发消息'], textarea:not([disabled]):not([hidden])")
        : doc.querySelector("#prompt-textarea[contenteditable='true'], textarea#prompt-textarea, " +
          "textarea[data-id='root'], form textarea"),
      sendControl: (node) => node?.closest?.(deepSeek
        ? "button[type='submit'], [data-testid='send-button'], " +
          ".ds-button--primary.ds-button--circle[role='button'], " +
          "[role='button'][aria-label*='发送'], [role='button'][aria-label*='send' i], " +
          "[role='button']:has(svg path[d^='M8.3125'])"
        : "button[data-testid='send-button'], button[data-testid='composer-submit-button'], " +
          "button[aria-label='发送提示词'], button[aria-label='Send prompt']"),
      generating: (node) => !!(
        node?.closest("[aria-busy='true'], [data-is-streaming='true'], [data-streaming='true']") ||
        doc.querySelector("button[data-testid='stop-button'], [aria-label='Stop streaming'], " +
          "[aria-label='Stop generating'], [aria-label='停止生成'], [aria-label='停止回答'], " +
          ".ds-button--circle[role='button']:has(svg path[d^='M2 4.88']), .ds-markdown--streaming")
      ),
    };
  }

  function isNexusTag(node) {
    if (!node) return false;
    for (const field of ["data-language", "data-lang", "data-code-language"]) {
      if (node.getAttribute(field)?.toLowerCase() === "nexus") return true;
    }
    return [...node.classList].some((label) => /^(?:language|lang)-nexus$/i.test(label));
  }

  function hasLanguageLabel(pre, code) {
    if (isNexusTag(pre) || isNexusTag(code)) return true;
    // Unknown fence languages are often displayed in the header, even when
    // the site's highlighter did not set a language class on <code>.
    const container = pre.parentElement;
    const selectors = "[class*='language'], [class*='__lang'], [class*='code-block-header'], " +
      "[class*='code-block__header'], [class*='code-header'], [data-testid*='code-block-header']";
    return [pre, ...(container?.querySelectorAll("pre").length === 1 ? [container] : [])].some((area) => {
      const labels = [...area.querySelectorAll(selectors)];
      const adjacent = area === pre ? pre.firstElementChild : pre.previousElementSibling;
      if (adjacent && adjacent !== code && !adjacent.contains(code) &&
        ((area === pre && adjacent.tagName !== "CODE") ||
          area.matches("[class*='code-block'], [data-testid*='code-block']"))) labels.push(adjacent);
      return labels.some((label) => (isNexusTag(label) ||
        [label, ...label.querySelectorAll("span,div")].some((child) =>
          !child.closest("code,button") && normalized(child.textContent).toLowerCase() === "nexus")));
    });
  }

  function callFromMessage(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(REASONING + ", [hidden], [aria-hidden='true']").forEach((child) => child.remove());
    const blocks = [];
    for (const pre of clone.querySelectorAll("pre")) {
      const code = pre.querySelector("code") ?? pre.querySelector("[class*='code-content']");
      if (hasLanguageLabel(pre, code)) blocks.push((code ?? pre).textContent);
      pre.remove();
    }
    const literal = /nexus/i.test(clone.textContent) ? literalText(clone) : "";
    blocks.push(...P.rawFence(literal));
    return P.onlyCall(blocks);
  }

  function literalText(node) {
    function walk(item) {
      if (item.nodeType === 3) return item.nodeValue ?? "";
      if (item.nodeType !== 1) return "";
      if (item.tagName === "BR") return "\n";
      const text = [...item.childNodes].map(walk).join("");
      return /^(?:P|DIV|SECTION|ARTICLE|LI|BLOCKQUOTE)$/.test(item.tagName) ? "\n" + text + "\n" : text;
    }
    return walk(node);
  }

  function draftValue(input) {
    if (!input) return "";
    return input.tagName === "TEXTAREA" ? input.value : textOf(input);
  }

  function appendDraft(input, payload, current = () => true) {
    if (!current() || !input?.isConnected || typeof payload !== "string" || !payload) return false;
    const old = draftValue(input);
    const separator = old.trim() ? "\n\n" : (old ? "\n" : "");
    if (input.tagName === "TEXTAREA" && !input.disabled && !input.readOnly) {
      const win = input.ownerDocument.defaultView;
      if (input.maxLength >= 0 && old.length + separator.length + payload.length > input.maxLength) return false;
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value").set.call(input, old + separator + payload);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      return true;
    }
    if (!input.isContentEditable) return false;
    const doc = input.ownerDocument;
    input.focus({ preventScroll: true });
    if (!current() || !input.isConnected || doc.activeElement !== input || draftValue(input) !== old) return false;
    const selection = doc.getSelection();
    const end = doc.createRange();
    end.selectNodeContents(input);
    end.collapse(false);
    selection.removeAllRanges();
    selection.addRange(end);
    // Native editor insertion preserves the existing rich draft and notifies
    // ProseMirror/React without replacing the input's HTML or submitting.
    return doc.execCommand("insertText", false, separator + payload);
  }

  class TurnTracker {
    constructor(adapter) {
      this.adapter = adapter;
      this.wait = null;
      this.anchor = null;
    }
    userIntent(draft, now = Date.now()) {
      const expected = normalized(draft);
      if (!expected) return false;
      const users = this.adapter.users();
      const assistants = this.adapter.assistants();
      this.wait = {
        at: now,
        expected,
        users: new Set(users),
        userIds: new Set(users.map(messageId).filter(Boolean)),
        assistants: new Set(assistants),
        assistantIds: new Set(assistants.map(messageId).filter(Boolean)),
      };
      this.anchor = null;
      return true;
    }
    current(now = Date.now()) {
      const user = this.adapter.users().at(-1);
      const seen = this.wait;
      if (seen && !this.anchor && now - seen.at <= 15_000 && user && !seen.users.has(user) &&
        !(messageId(user) && seen.userIds.has(messageId(user))) &&
        (normalized(textOf(user)) === seen.expected || normalized(textOf(user)).includes(seen.expected))) {
        this.anchor = { node: user, id: messageId(user) };
      }
      if (!seen || !this.anchor || !user ||
        (user !== this.anchor.node && (!this.anchor.id || messageId(user) !== this.anchor.id))) return null;
      const reply = this.adapter.assistants().at(-1);
      if (!reply || seen.assistants.has(reply) || (messageId(reply) && seen.assistantIds.has(messageId(reply))) ||
        !(user.compareDocumentPosition(reply) & 4) || user.contains(reply)) return null;
      return reply;
    }
  }

  globalThis.NexusPage = Object.freeze({
    openAdapter, callFromMessage, messageId, draftValue, appendDraft, normalized, TurnTracker,
  });
})();
