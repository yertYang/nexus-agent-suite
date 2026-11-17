// SPDX-License-Identifier: MIT
// Use Marked only as a lexer. Model output never becomes HTML or an image request.
(() => {
  "use strict";
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  function copyButton(label, source, icon = false) {
    const button = el("button", "nv-copy");
    button.type = "button";
    const show = (text, state = "copy") => {
      button.setAttribute("aria-label", text);
      button.title = text;
      if (!icon) { button.textContent = text; return; }
      button.classList.add("nv-copy-icon");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", state === "done" ? "m5 12 4 4L19 6" : state === "error" ? "m7 7 10 10M7 17 17 7" : "M9 5V3h11v13h-3M4 8h11v13H4Z");
      svg.append(path); button.replaceChildren(svg);
    };
    show(label);
    button.setAttribute("aria-live", "polite");
    let timer;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(source);
        show("已复制", "done");
      } catch {
        show("复制失败，请手动复制", "error");
      }
      clearTimeout(timer);
      timer = setTimeout(() => { show(label); }, 2200);
    });
    return button;
  }
  function renderTokens(parent, tokens) {
    for (const t of tokens) {
      let node;
      switch (t.type) {
        case "space": continue;
        case "heading": node = el("h" + Math.min(6, t.depth + 1)); break;
        case "paragraph": node = el("p"); break;
        case "blockquote": case "strong": case "em": case "del": case "br": case "hr":
          node = el(t.type); break;
        case "list":
          node = el(t.ordered ? "ol" : "ul");
          if (t.ordered) node.start = t.start;
          renderTokens(node, t.items);
          parent.append(node); continue;
        case "list_item": node = el("li"); break;
        case "checkbox": parent.append(t.checked ? "☑ " : "☐ "); continue;
        case "link": {
          let url;
          try { url = new URL(t.href); } catch { /* Local paths remain text. */ }
          if (url && ["http:", "https:"].includes(url.protocol)) {
            node = el("a"); node.href = url.href; node.target = "_blank"; node.rel = "noopener noreferrer";
          } else { parent.append(t.raw); continue; }
          break;
        }
        case "html":
          if (t.block) {
            node = el("p", "nv-prose-plain"); node.textContent = t.raw; parent.append(node);
          } else parent.append(t.raw);
          continue;
        case "image": parent.append(t.raw); continue;
        case "codespan":
          node = el("code"); node.textContent = t.text; parent.append(node); continue;
        case "code": {
          const block = el("div", "nv-code-block"), bar = el("div", "nv-code-bar");
          const lang = el("span"), pre = el("pre"), code = el("code");
          lang.textContent = t.lang?.split(/\s+/)[0] || "代码";
          bar.append(lang, copyButton("复制代码", t.text));
          code.textContent = t.text; pre.append(code); block.append(bar, pre); parent.append(block); continue;
        }
        case "table": {
          const wrap = el("div", "nv-table-scroll"), table = el("table");
          const row = (cells, head) => {
            const tr = el("tr");
            for (const cell of cells) {
              const td = el(head ? "th" : "td");
              if (head) td.scope = "col";
              renderTokens(td, cell.tokens); tr.append(td);
            }
            return tr;
          };
          const head = table.createTHead(), body = table.createTBody();
          head.append(row(t.header, true));
          for (const cells of t.rows) body.append(row(cells, false));
          wrap.append(table); parent.append(wrap); continue;
        }
        case "text":
          if (t.tokens) renderTokens(parent, t.tokens);
          else parent.append(t.text);
          continue;
        default: parent.append(t.text ?? t.raw); continue;
      }
      if (t.tokens) renderTokens(node, t.tokens);
      parent.append(node);
    }
  }
  globalThis.NaviReply = Object.freeze({
    render(source, options = {}) {
      const reply = el("div", "nv-reply"), prose = el("div", "nv-prose");
      try { renderTokens(prose, globalThis.marked.lexer(source, { gfm: true, breaks: true })); }
      catch {
        prose.replaceChildren(source);
        prose.classList.add("nv-prose-plain");
      }
      reply.append(prose, copyButton("复制回复", source, options.copyIcon === true));
      return reply;
    },
  });
})();
