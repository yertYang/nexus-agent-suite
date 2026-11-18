# Navi

Navi 有两个独立应用项目：工作台和 Chrome 右侧对话扩展。工作台提供本机模式和单独启动的团队网站。无需安装 Codex。两者共用独立维护、可打包发布的 Navi UI 组件库。

## 下载安装

| 安装包 | 安装方式 |
| --- | --- |
| [下载 Navi Link 浏览器插件（ZIP）](downloads/navi-link.zip?raw=true) | 解压到固定目录。在 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions` 打开开发者模式，点「加载已解压的扩展程序」，选择含 `manifest.json` 的目录。需要 Chromium 116+。 |
| [下载 Navi 桌面工作台（macOS ZIP）](downloads/navi-desktop-macos.zip?raw=true) | 支持 macOS 12+，Intel 和 Apple 芯片。先安装 Node.js 24+ 并确保 Corepack 可用，再完整解压到可写目录，打开其中的 `Navi.app`。保留旁边的 `agent-workbench/`；首次启动需要联网准备依赖。 |

桌面包使用本地签名，未经 Apple 公证。[下载校验文件](downloads/SHA256SUMS)；把它与两个 ZIP 放在同一目录后，可运行 `shasum -a 256 -c SHA256SUMS`。维护者从套件根目录运行 `npm run clients:pack`（需要 Python 3、Node.js 24+ 和 zip）即可重新生成这两个下载文件。

| 项目 | 用途 |
| --- | --- |
| [Navi](agent-workbench/README.md) | API 模型对话、本机项目权限、逐次审批、网址用例测试和服务器部署管理 |
| [Navi Link](browser-extension/README.md) | Chrome 侧栏聊天、网页操作、本机目录与文件工具、对话测试和网页账号模式 |

在 macOS Finder 双击套件根目录的 **Navi.app**。工作台会准备本机组件、打开浏览器并登录。日常使用可以直接在网页中授权目录、配置模型、发起浏览器任务和查看审批；无需打开终端。

启动时如提示系统不允许本机回环连接或监听（`EPERM` / `EACCES`），请换到允许回环网络的运行环境；此提示不表示需要结束占用端口的进程。

## 多人团队网站

在 `agent-workbench` 目录运行 `npm run team:init -- admin` 初始化账号，再运行 `npm run team:start`，打开 `http://127.0.0.1:17890`。管理员分配成员账号；每人用自己的密码登录，在「任务文件」给指定成员授予只读或编辑权限。成员可绑定 Navi Link 继续个人对话，或绑定自己电脑的已授权项目，在本机批准目录任务。服务器部署操作仅供管理员使用。

[团队网站使用与部署](agent-workbench/docs/TEAM_SITE.md)包含 HTTPS 配置、模型连接、插件配对及目录任务步骤。当前仓库提供实现与验收记录，不代表已经发布公网网站。本机模式仍可独立使用。

从 GitHub 更新 Linux 服务器，见[首次发布、拉包、更新与恢复](agent-workbench/docs/SERVER_RELEASE.md)。推送 `team-vX.Y.Z` 标签后，发布工作流检查 UI 并构建 GHCR 镜像与部署包。服务器按指定镜像摘要更新，停服备份后复用原数据，不需要重新初始化账号。需要回退时，`update.sh --restore` 从所选备份一起恢复旧镜像和数据，并保留回退前的数据。Chrome 扩展和桌面工作台分别更新。

## 开始使用

桌面工作台升级后，请先结束进行中的任务，在 Finder 双击套件根目录的[重启 Navi.command](重启%20Navi.command)。它会核对端口、用户和启动脚本，正常停止当前套件的桌面工作台，再打开 Navi。重启后旧配对失效，需从扩展重新连接。

1. 在 Navi「连接设置」填写模型服务的 URL 和 API Key，点击 **保存并连接**。验证成功后配置立即生效，在对话输入区选择真实模型。失败会显示原因并保留输入；仅填写而未保存不会启用模型。
2. 选择已有项目即可开始对话。工作目录首次登记后会保留，无需每次创建；做另一个独立项目时，再到「项目与权限」添加目录。
3. 在对话中读写文件、运行经批准的命令，或提供项目相对目录和完整网址来测试。支持 Excel、Word、Markdown 文档和符合项目运行条件的 Playwright、Selenium 脚本。
4. Navi Link 可独立使用：加载扩展并打开 Chrome 侧栏，点击输入区设置图标，在弹窗选择独立模式，配置支持 Responses 的 API URL 和 Key，即可聊天、打开百度搜索、读取/填写/点击网页，**无需启动 Navi 或连接 MCP**。模型在输入区下拉选择，服务声明支持时可选思考强度；文本框、文件夹和缩小的发送／停止图标同排。独立和本机模式下，“打开百度网站搜索苹果”都只确认一次；对话默认隐藏操作明细，可点击记录图标查看。详见 [扩展说明](browser-extension/README.md)。
5. 在独立模式点输入框旁的文件夹图标，从浏览器选择并授权一个本地目录。发送「列出根目录」或「读取 README.md」，批准对应工具调用后，目录列表或文本会送到已配置的模型服务。此流程只需扩展。需要写入文件、在 Finder 打开目录或运行项目用例时，可连接 Navi 工作台并切换到本机模式，按项目授予相应权限。ChatGPT／DeepSeek 网页账号模式继续可用。

独立模式不要求本机工具连接，支持提供 `/models` 与 `/responses` 的模型服务；仅 Chat Completions 服务暂不可用。本机配对请求 2 分钟内有效，侧栏授权 12 小时，网页工具令牌 7 天；工作台重启须重新配对。Finder 目录打开目前仅支持 macOS，尚不提供整桌面鼠标键盘控制。

工作台和插件侧栏都按 Markdown 展示模型回复，支持复制整条回复或单个代码块。插件用图标复制回复，正常结束不显示「已完成」标签；发送等待图标居中。独立模式对明确的网页操作指令要求返回浏览器工具调用，未返回调用会明确报错；本机模式缺少网页操作权限时先提示授权。

## 服务器部署管理

Navi 的「部署管理」页用于检查容器状态、更新或重启应用，以及打开已配置的管理面板。部署目标在本机私有文件中维护，页面不提供配置表单，也不回显连接信息。工作台保持本机访问，SSH 密钥和主机指纹由本机 SSH 管理；当前支持一个应用、一个 Compose 文件，不负责安装 1Panel、升级 Docker 引擎、自动备份或回滚。

使用步骤、服务器条件和中断恢复见 [Navi 部署管理](agent-workbench/README.md#部署管理)。目前已验证部署逻辑和合成执行流程，尚未完成真实服务器及浏览器界面验收。

## Codex 请求兼容

工作台网页与扩展本机模式共用工作台后端；扩展独立模式直接访问所配置的 `/v1/responses`。同一对话保持 `session-id` 和 `thread-id`，每条用户消息有独立的 `x-codex-turn-id`，每次 HTTP 请求使用新的 `x-client-request-id`。保留完整历史和工具结果，不要求本机安装 Codex CLI。

时间上下文由后端按用户轮次生成，记录 UTC 绝对时间，历史内容保持原样。使用 codex-proxy 时，时区与结构化搜索位置按网关策略对齐：代理位置优先，其次是已启用的全局位置。Navi 不读取本机地区设置、不伪造 Codex 客户端身份，也不替换真实出口 IP。普通 Client Key 无法更改网关的管理设置；位置覆盖未启用、网关切换账号或代理时，不能保证位置不变。其他兼容网关是否支持这些字段由该服务决定。

## UI 库与发布

[Navi UI](design-system/navi-ui/README.md) 的源文件位于 `design-system/navi-ui/`，可打开[中文组件文档](design-system/navi-ui/preview.html)按分类试用控件、查看代码和用法。Navi UI 的色板、按钮和表单参考 Element UI，保持原生控件和离线运行。两个应用各自携带可独立运行的组件副本，不依赖上级目录。

- `npm run ui:sync`：把库内样式和对话渲染脚本同步到两个应用。
- `npm run ui:check`：验证两个应用的副本；若 `outputs/` 中已有当前版本的安装包，也逐文件核对包内容与源码。
- `npm run ui:pack`：在本机生成并校验 `outputs/navi-ui-0.4.1.tgz`。安装包由源码生成，不随 Git 提交。

当前包名 `@navi/ui` 为暂定名称；正式发布前需确认 npm scope 归属和发布账号。应用代码仍遵循各自许可证；新 UI 库使用其目录中的 MIT 许可证。

## 当前验收

历史验证结果和当时未覆盖的范围见[功能测试报告](outputs/功能测试报告-2026-11-17.md)。

真实 Chrome 侧栏已通过“读取本地 Markdown 用例 → 访问指定测试网址 → 填写并提交 → 页面断言 → 展示截图”的完整流程。模型、Nexus Runner 和 Chromium 均为实际服务，网页和用例为合成测试数据。现有脚本、Office 和其他浏览器场景的验证范围见[验收记录](agent-workbench/docs/VALIDATION.md)。

## 文档维护

每次功能、配置流程或界面组件变更，都必须同批更新相关项目的 README；README 描述当前版本的实际行为。过时步骤应替换或删除，未实现和未实测的能力要明确标注，不能只追加变更记录。

阅读[架构说明](ARCHITECTURE.md)和[验收记录](agent-workbench/docs/VALIDATION.md)，了解哪些链路实测，哪些需要你的账号。多人网站的设计与交付边界见[多人后台方案](agent-workbench/docs/MULTI_USER.md)。
