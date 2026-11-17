// SPDX-License-Identifier: GPL-3.0-only
// Only explicit browser action requests; questions, quotations and negations stay ordinary chat.
(() => {
  globalThis.NaviIntent = Object.freeze({
    browserAction(value) {
      if (typeof value !== 'string') return false;
      const text=value.trim();
      if (/[?？“”"「」]|如何|怎么|为什么|是否|能否|能不能|可不可以|不要|不用|别帮|解释|举例|翻译|写.*代码/.test(text)) return false;
      return /^(?:请|帮我|麻烦|现在|用|通过|在|打开|读取|点击|搜索|浏览器|Chrome|Edge|百度)/i.test(text) &&
        /浏览器|chrome|edge|网页|网站|百度|https?:\/\//i.test(text) && /打开|搜索|读取|点击|填写|访问|导航/.test(text);
    },
  });
})();
