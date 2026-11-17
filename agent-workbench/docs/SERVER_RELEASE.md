# Linux 团队网站部署包

部署包来自团队网站的版本发布，包含 Compose 配置、站点配置模板、更新脚本和锁定镜像摘要的 `image.env`。需要 Linux、Docker Compose v2（支持 `up --wait`）及可拉取该镜像的账号。发布流程检查 UI 并构建镜像；不执行账号、对话或数据库恢复测试。

在自己的 GitHub 仓库启用 Actions，允许发布工作流写入 Packages 和 Releases。提交源码后，推送一个新标签（例如 `git tag team-v1.0.0`、`git push origin team-v1.0.0`）；普通 push 不触发生产发布。工作流生成 linux/amd64 和 linux/arm64 镜像，在 Release 列出精确摘要。私有包需用执行拉包的 Docker 账号登录 GHCR，仅授予读取包权限。

首次安装：从同一 Release 下载 `navi-team-deploy.tgz` 和 `SHA256SUMS`，执行 `sha256sum -c SHA256SUMS`。通过后，将部署包解压到 root 管理的空目录，在该目录执行：

```sh
cp site.env.example site.env
sudo install -d -m 0700 -o 1000 -g 1000 data config
```

将 `site.env` 的外部地址改为实际 HTTPS 域名。需要聊天时设置模型地址、模型 ID 和容器内密钥文件路径，将密钥单独放入绑定挂载的 `config/`，文件归 UID 1000 所有、权限 0600。反向代理须保留原始 Host 并转发到配置的环回端口（默认 17890）。

```sh
sudo docker compose --env-file image.env pull team
sudo docker compose --env-file image.env run --rm team init admin
sudo docker compose --env-file image.env up -d --wait team
```

初始化时在终端输入首个管理员密码。更新健康的已有实例时，用新发布页给出的完整镜像引用（同一仓库，含 `@sha256:` 摘要）作为 `sudo ./update.sh` 的唯一参数。脚本在停服后备份数据与旧镜像引用，切换版本，等待健康检查。配置和模型密钥需自行私下备份。

每次用新标签发布；不要用新部署包覆盖线上 `image.env`、`site.env` 或 `data/`。先在维护窗口暂停对外流量和设备任务，留出完整备份空间，再在原安装目录执行：

```sh
sudo ./update.sh 'ghcr.io/组织/仓库@sha256:从新Release复制的完整摘要'
```

保持原域名和数据挂载。健康检查只确认站点能读取账号库；恢复流量前，再用原账号核对历史、共享文件和模型。浏览器扩展和桌面工作台不会随网站更新。服务器对外只代理团队网站，不代理本机工作台 17880 或 MCP 18080。

**恢复旧版**：在维护窗口内，从更新日志选定本次更新前的备份目录，在原安装目录执行（将示例目录换成实际名称）：

```sh
sudo ./update.sh --restore backups/实际备份目录
```

脚本要求原 Compose 实例仍存在（可以已停止），并核对数据挂载、备份完成标记和同仓库的旧镜像摘要。它先复制备份，用旧镜像里的 SQLite 检查副本的完整性和账号表；这一步失败不会停服务。通过后才停服，将当前数据留存在 `backups/before-restore.*/prior-data`，用备份副本重建旧版容器，健康检查通过才写回镜像版本。原备份不变。需预留一份完整数据副本的空间，模型 Key、域名和 SSH 配置沿用安装目录中的设置。

恢复后，在线网站回到备份时点，之后的写入只存在于恢复前留存的数据中。核对原账号、聊天和共享文件后再开放流量。旧部署包如果没有 `--restore` 选项，先从已校验的新包更新 `update.sh`，不要覆盖 `image.env` 和站点配置。
