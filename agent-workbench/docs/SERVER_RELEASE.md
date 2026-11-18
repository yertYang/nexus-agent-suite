# Linux 团队网站部署包

部署包来自团队网站的版本发布，包含 Compose 配置、站点配置模板、更新脚本和锁定镜像摘要的 `image.env`。需要 Linux、Docker Compose v2（支持 `up --wait`）及可拉取该镜像的账号。发布流程检查 UI 并构建镜像；不执行账号、对话或数据库恢复测试。

在自己的 GitHub 仓库启用 Actions，允许发布工作流写入 Packages 和 Releases。提交源码后，推送一个新标签（例如 `git tag team-v1.0.0`、`git push origin team-v1.0.0`）；普通 push 不触发生产发布。工作流生成 linux/amd64 和 linux/arm64 镜像，在 Release 列出精确摘要。私有包需用执行拉包的 Docker 账号登录 GHCR，仅授予读取包权限。

## 默认安装

在使用 systemd 的 Linux 主机上准备 Docker Compose v2、GNU coreutils 和 util-linux。私有镜像需要给主机的 root 账号配置 GHCR 读取权限。从同一 Release 下载 `navi-team-deploy.tgz` 和 `SHA256SUMS`，在下载目录校验后，将发布包解压到 root 管理的空安装目录。以下以 `/opt/navi-team` 为例。

```sh
sha256sum -c SHA256SUMS &&
  sudo install -d -m 0755 /opt/navi-team &&
  sudo tar --no-same-owner -xzf navi-team-deploy.tgz -C /opt/navi-team
cd /opt/navi-team
sudo install -m 0600 site.env.example site.env
sudoedit site.env
```

在 `site.env` 填写实际的 HTTPS 站点地址。反向代理须保留原始 Host，转发到配置的环回端口（默认 17890）。需要聊天时配置模型地址、模型 ID 和容器内密钥路径；提前创建 `config/` 并放入归 UID 1000 所有、权限 0600 的密钥文件。

```sh
sudo bash install.sh
```

首次安装会提示设置管理员密码，随后启动网站、启用开机运行的主机部署服务，并从站点容器检查心跳和请求目录写权限。看到安装成功提示后，使用管理员账号登录「部署管理」即可点击「一键部署」。默认从当前 GHCR 仓库的 `team-stable` 标签拉取更新。发布工作流在创建团队 Release 后更新此标签，主机将其解析为镜像摘要并执行备份、更新和就绪检查。

## 已有站点和手动更新

在原安装目录复用原有的 `image.env`、`site.env`、`data/`、`config/`、`deployment.env` 和自定义 override。旧版站点先用原来的 `update.sh` 升级到带部署管理的团队镜像。从已校验的新包复制 `install.sh`、`update.sh`、`deploy-once.sh` 和 `navi-team-deploy@.service`。使用标准 Compose 的站点同时复制新版 `compose.yaml`；自定义 Compose 的站点合并其中的部署目录环境变量及两项部署挂载。然后在原目录运行 `sudo bash install.sh`。重复运行会复用已有账号和部署来源，安装中断后也可以重试。

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

## 启用团队网站一键部署

默认安装会生成仅 root 可读的 `deployment.env`。运维人员可在主机修改来源：

- `NAVI_DEPLOY_SOURCE=docker` 使用 `NAVI_DEPLOY_IMAGE` 指定同仓库的 Docker 标签或镜像摘要。默认使用 `team-stable`，也可指定特定发布版本。
- `NAVI_DEPLOY_SOURCE=github` 使用 `NAVI_DEPLOY_GITHUB_REPO=组织/仓库`。主机须安装并认证 GitHub CLI。部署服务下载 Latest 正式 `team-vX.Y.Z` Release 的部署包和校验和，校验后读取同仓库的镜像摘要。

主机部署任务在网站容器重建期间继续执行。修改来源后，等当前任务结束，在原安装目录执行以下命令载入配置：

```sh
instance=$(systemd-escape --path "$(pwd -P)")
sudo systemctl restart "navi-team-deploy@$instance.service"
```

页面提示「此站点尚未启用一键部署」时，核对是否已使用带部署挂载的 Compose 配置并完成默认安装。「部署服务离线」表示站点已配置部署目录，正在等待主机心跳。可用 `sudo journalctl -u "navi-team-deploy@$instance.service"` 检查主机日志。更新失败时按上文的恢复步骤处理。
