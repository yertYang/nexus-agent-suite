# Navi 浏览器任务

从Navi的「浏览器任务」可直接填入网址和步骤，真实 API 模式会先观察指定页面的标题、可见文字和控件，再制定新的计划。观察、创建计划和执行分开审批；实际执行时才生成报告和截图。内置表单只是演示。在首次使用时点击「准备浏览器环境」。

手动复验时，在工作台根目录执行 `npm run prepare:browser`。默认查找已安装的 Chromium、Chrome 或 Edge（使用独立上下文）。可用项目内未纳入版本控制的 `browser.local.json` 配置 `{"executablePath":"/absolute/path/to/chrome"}`。如果本机原生浏览器受限，运行 `npm run browser:up` 启用固定版本的 Docker Playwright/Chromium，停止时用 `npm run browser:down`。

在本示例目录独立运行内置表单，或观察指定网页：

```sh
npm run demo
node browser-test.mjs --mode inspect --url https://example.com/
```

独立运行会在断言失败时返回非零退出码。Nexus Runner 会在收到非零退出时丢弃标准输出，所以由工作台发起时使用 `--report-mode runner`：完整报告发出后进程退出码代表传输成功，**报告的 `status`** 仍明确表示用例通过或失败，工作台也按用例状态标记工具结果。未返回完整报告时不得报告测试成功。

命令参数无效时也会按请求返回失败结果：观察请求返回观察结果，其他请求返回执行报告。

可用步骤包括访问同来源页面、按文字、角色、标签或 test ID 定位控件、填写、点击、选择、勾选、核对文字或可见状态、截图。判断是否通过以执行报告为准；观察只返回可见内容，不读取输入框里的已填值。

- 默认起一个只绑定环回、由用例自己关闭的表单测试服务。用 `--url https://example.test/start` 选择实际站点；导航步骤须匹配其地址和选择器。可显式添加多个 `--allow-origin` 供目标站点加载必要的资源。
- 仅访问被允许的 HTTP(S) 来源，阻止重定向、未允许的资源、Service Worker 和 WebSocket。每次使用新的上下文，不共享日常浏览器配置、Cookie 或历史。不要把账号密码写入用例。
- 失败时如果页面已打开，也会尽力截取当时的页面。输出在 `.nexus-test-output/`；工作台通过鉴权接口显示内存中的小幅 JPEG，不按路径提供任意本地文件。
- **真实测试不等于真实模型**：模拟模型也能生成样例用例，并由真实 Runner 和 Chromium 实际执行。外部网站需要用其实际页面验证权限和步骤。
