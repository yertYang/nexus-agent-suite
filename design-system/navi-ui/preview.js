// SPDX-License-Identifier: MIT
(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const make = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const pages = [...document.querySelectorAll("main > article")];
  const name = page => page.querySelector("h1").textContent;
  const groups = new Map();
  for (const page of pages) {
    const group = page.dataset.group;
    if (!groups.has(group)) {
      const section = make("div"), options = make("optgroup");
      section.append(make("h2",group)); options.label = group;
      $("#catalog").append(section); $("#mobile-nav").append(options);
      groups.set(group,{section,options});
    }
    const link = make("a",name(page)), option = make("option",name(page));
    link.href = "#" + page.id; option.value = page.id;
    groups.get(group).section.append(link); groups.get(group).options.append(option);
  }

  const buttons = [["secondary","默认"],["primary","主要"],["success","成功"],["info","信息"],["warning","警告"],["danger","危险"]];
  for (const [kind,label] of [["normal","标准"],["plain","浅色"],["round","圆角"]]) {
    const row = make("div"), caption = make("span",label);
    row.className = "nv-row"; caption.className = "row-label"; row.append(caption);
    for (const [type,text] of buttons) {
      const b = make("button",text+"按钮"); b.type = "button"; b.className = "nv-button"; b.dataset.variant = type;
      if (kind === "round") b.dataset.shape = "round";
      if (kind === "plain") b.dataset.plain = "";
      row.append(b);
    }
    $("#button-demo").append(row);
  }
  const announce = make("output","点击任一按钮试用。"); announce.className = "output"; announce.setAttribute("aria-live","polite");
  $("#button-demo").append(announce);
  for (const b of $("#button").querySelectorAll("button")) b.addEventListener("click",()=>{
    announce.textContent = "已点击：" + b.textContent + "。";
  });
  for (const [key,label] of [["brand","品牌蓝"],["accent","交互蓝"],["success","成功"],["warning","警告"],["danger","危险"],["info","信息"]]) {
    const entry = make("div"), chip = make("i");
    entry.className = "swatch"; chip.style.setProperty("--sample","var(--nv-"+key+")");
    entry.append(chip, make("b",label),make("code",getComputedStyle(document.documentElement).getPropertyValue("--nv-"+key).trim().toUpperCase()));
    $("#swatches").append(entry);
  }
  $("#project-id").addEventListener("input",e=>{
    const valid = e.target.validity.valid;
    e.target.setAttribute("aria-invalid",String(!valid));
    $("#field-hint").textContent = valid ? "使用小写字母、数字或短横线。" : "项目标识不能为空，只能包含小写字母、数字或短横线。";
  });
  const reply = "## 项目检查结果\n\n**检查通过。** 下一步可以在项目根目录运行测试：\n\n```sh\nnpm test\n```";
  $("#sample-reply").append(NaviReply.render(reply));
  const api = {
    button:[["data-variant","primary / secondary / success / info / warning / danger / ghost"],["data-plain","浅色按钮；省略时使用默认外观"],["data-shape","round；图标按钮可用 circle"],["data-size","sm 为紧凑尺寸，省略为标准尺寸"]],
    color:[["--nv-brand","品牌与文档标识"],["--nv-accent","主要操作、焦点与选中状态"],["--nv-text / --nv-muted","正文和辅助信息"]],
    input:[[".nv-input / .nv-textarea","单行或多行输入"],["aria-invalid","标记校验失败；同时提供错误说明"],["disabled","禁止输入"]],
    select:[[".nv-select","原生单选下拉框"],["data-variant","plain 为无边框工具栏模式"],["data-size","sm 为紧凑尺寸"]],
    choice:[[".nv-check","包裹原生 input 和文字的 label"],["type","checkbox 或 radio"],["name","相同 name 的单选框为一组"]],
    switch:[[".nv-switch","用于 type=checkbox、role=switch 的 input"],["checked / disabled","沿用原生勾选与禁用状态"]],
    tag:[[".nv-status","静态状态文字"],["data-tone","neutral / info / success / warning / danger"]],
    card:[[".nv-card","白色表面、边框与轻阴影；内边距由使用方控制"]],
    table:[[".nv-table-wrap","在窄容器中独立横向滚动"],[".nv-table","使用原生 table 及列标题"],["data-stripe","可选的隔行底色"]],
    collapse:[[".nv-collapse","用于原生 details"],["summary","面板标题"],["open","设置初始展开状态"]],
    alert:[[".nv-alert","说明或反馈内容"],["data-tone","info / success / warning / danger"],["role","动态提示按需使用 status 或 alert"]],
    reply:[["NaviReply.render(markdown)","将原文转换为可插入的 DOM 元素"],["marked.js → reply.js","按此顺序加载两个本地脚本"]],
  };
  for (const page of pages) {
    for (const box of page.querySelectorAll(".example")) {
      const details = make("details"), summary = make("summary","查看示例代码"), pre = make("pre");
      let snippet = box.querySelector(".demo").innerHTML.trim().replace(/></g,">\n<");
      if (page.id === "reply") snippet = 'document.querySelector("#reply").append(\n  NaviReply.render(' + JSON.stringify(reply) + ')\n);';
      if (page.id === "color") snippet = '.brand { background: var(--nv-brand); }\n.action { color: var(--nv-accent); }';
      pre.append(make("code",snippet)); details.append(summary,pre); box.append(details);
    }
    const wrap = make("div"), table = make("table"); wrap.className = "nv-table-wrap"; table.className = "nv-table";
    const row = table.createTHead().insertRow();
    for (const text of ["名称","用法"]) {const th=make("th",text); th.scope="col"; row.append(th);}
    const body = table.createTBody();
    for (const [key,value] of api[page.id]) {
      const tr = body.insertRow(); tr.insertCell().append(make("code",key)); tr.insertCell().textContent = value;
    }
    wrap.append(table); page.append(make("h2","使用说明"),wrap);
  }
  function show() {
    const active = pages.find(p=>p.id === location.hash.slice(1)) || pages[0];
    for (const page of pages) page.hidden = page !== active;
    for (const link of $("#catalog").querySelectorAll("a")) {
      if (link.hash === "#"+active.id) link.setAttribute("aria-current","page"); else link.removeAttribute("aria-current");
    }
    $("#mobile-nav").value = active.id; $("#group").textContent = active.dataset.group;
    document.title = name(active)+" · Navi UI";
    const index = pages.indexOf(active);
    for (const [link,other,prev] of [[$("#prev"),pages[index-1],true],[$("#next"),pages[index+1],false]]) {
      link.hidden = !other;
      if (other) { link.href = "#"+other.id; link.textContent = prev ? "← "+name(other) : name(other)+" →"; }
    }
    window.scrollTo(0,0);
  }
  $("#mobile-nav").addEventListener("change",e=>{location.hash=e.target.value;});
  $("#search").addEventListener("input",e=>{
    const query = e.target.value.trim().toLowerCase();
    for (const {section} of groups.values()) {
      const links = [...section.querySelectorAll("a")];
      for (const link of links) link.hidden = !link.textContent.toLowerCase().includes(query);
      section.hidden = links.every(link=>link.hidden);
    }
    $("#no-match").hidden = [...groups.values()].some(({section})=>!section.hidden);
  });
  window.addEventListener("hashchange",show); show();
})();
