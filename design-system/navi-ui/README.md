# Navi UI

Navi Workbench 和 Navi Link 共用的界面组件库。基础样式无需 JavaScript 或 CDN；对话正文另有可选的本地脚本。先加载 `tokens.css`，再加载 `components.css`；把 `chevron-down.svg` 放在相同目录。打开[中文组件文档](preview.html)可按分类、中文或英文名查找示例，操作控件、展开示例代码并查看用法。手机可从顶部目录切换组件。文档可离线打开，随 npm 包分发。色彩、4px 圆角、按钮层级和演示布局参考 [Element UI 官方组件文档](https://element.eleme.io/#/zh-CN/component/button)，保留 Navi 自己的原生 HTML 接口，不依赖 Vue。品牌蓝为 `#409EFF`，按钮及状态文字使用对比度更高的深色。主操作使用蓝色，次操作使用描边，卡片用细边框和轻阴影划分内容。

Navi Link 在应用自己的 `panel.css` 中组合底部模型菜单、同排输入与操作图标、独立提示行和原生 `<dialog>` 设置弹窗，并局部覆盖圆角与主按钮颜色。这些是扩展布局，不修改库的默认视觉样式；工作台继续使用原有组件外观。

```html
<link rel="stylesheet" href="./ui/tokens.css">
<link rel="stylesheet" href="./ui/components.css">

<div class="nv-row" data-density="compact">
  <button type="button" class="nv-button" data-variant="primary">连接 Navi</button>
  <span class="nv-status" data-tone="success">已连接</span>
</div>
```

| 类名 | 用法 |
| --- | --- |
| `.nv-button`、`.nv-icon-button` | `data-variant="primary/secondary/success/info/warning/danger/ghost"`、`data-size="sm/md"`；`data-plain` 为浅色，`data-shape="round"` 为圆角；图标按钮支持 `circle`，需要可读名称 |
| `.nv-field`、`.nv-label`、`.nv-input`、`.nv-textarea`、`.nv-select` | 用原生标签和表单控件；`aria-invalid="true"` 标记无效字段；`data-variant="plain"` 适用于工具栏的原生下拉框；输入框和下拉框可设 `data-size="sm"` |
| `.nv-check`、`.nv-switch` | 原生复选、单选和开关；开关使用 `type="checkbox" role="switch"` 并关联可读标签 |
| `.nv-alert`、`.nv-collapse` | 语义提示和原生 details 折叠面板 |
| `.nv-table-wrap`、`.nv-table` | 可横向滚动的表格；可用 `data-stripe` 设置隔行底色 |
| `.nv-card` | 卡片表面，由应用安排内部间距 |
| `.nv-status` | `data-tone="neutral/success/warning/danger/info"`；动态播报按需添加 `role="status"` |
| `.nv-stack`、`.nv-row` | 堆叠或可换行的横向布局，可覆盖 `--nv-gap` |

对话回复依次加载本地 `marked.js`（Marked 18.2.0，MIT，许可证见 `marked-LICENSE`）和 `reply.js`，将 `NaviReply.render(markdown)` 返回的元素插入对话区。渲染器将 Markdown 标记转换成段落、标题、列表、引用、表格和代码块，只允许 HTTP(S) 链接，不加载回复中的图片或执行 HTML。复制整条回复保留 Markdown 原文，复制代码只取代码正文。`NaviReply.render(markdown, { copyIcon: true })` 可将整条回复的复制按钮显示为图标，带可读名称、悬停提示及成功／失败图标；默认文字按钮保持兼容，代码块复制不变。

单选下拉框沿用原生 `<select>`。支持 `appearance: base-select` 且使用精细指针的浏览器会显示白底浮层、选中行和勾选标记；触屏、强制颜色模式或不支持该特性的浏览器沿用系统菜单。工作台与扩展侧栏在支持的浏览器中使用 `<button type="button"><selectedcontent></selectedcontent></button>` 作为 select 的首个子元素，收起时文字与箭头垂直居中，长名称显示省略号。

按钮和表单支持键盘焦点及原生 `disabled`。下拉框使用 `data-variant="plain"` 时，控件在悬停、键盘聚焦和展开时也不显示外边框；键盘焦点以下划线标出。使用 `aria-busy="true"` 显示等待状态；需要阻止重复提交时同时使用 `disabled`。非按钮元素的 `aria-disabled` 只提供状态，应用须自行拦截激活操作。默认 14px，父级 `data-density="compact"` 使用 13px。

在套件根目录运行 `npm run ui:sync` 更新清单和两处本地副本，运行 `npm run ui:check` 验证。单独维护项目时也可在该项目内运行 `npm run ui:check`，校验副本与随附清单。源文件仅在本目录修改；项目样式中保留布局和组件覆盖。

独立发布包的暂定名称为 `@navi/ui`。在本目录运行 `npm pack`，或从套件根目录运行 `npm run ui:pack` 生成到 `outputs/`；用 `-- --out-dir /path/to/artifacts` 指定其他目录。当前版本是 0.4.1，内含回复复制图标。套件命令在生成安装包后逐文件验证；若目标目录已有当前版本的安装包，`npm run ui:check` 也会检查它，遇到过期包时提示重新打包。除可选的对话脚本外，包导出 `@navi/ui/tokens.css`、`@navi/ui/components.css`、`@navi/ui/chevron-down.svg`。用打包器导入时仍须保留组件 CSS 对图标的相对引用，或者把三个文件复制到一起。正式发布前先确认 npm scope 的归属、包名可用性、发布账号和 CI 的权限。
