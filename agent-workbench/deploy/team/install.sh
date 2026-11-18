#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
die() { echo "$*" >&2; exit 1; }
[[ $EUID == 0 && -d /run/systemd/system ]] || die '请在使用 systemd 的 Linux 主机以 root 运行安装。'
[[ -f site.env && -f image.env ]] || die '请先配置 site.env，并保留发布包中的 image.env。'
for tool in docker systemctl systemd-escape flock setpriv timeout dd; do
  command -v "$tool" >/dev/null || die "缺少安装依赖：$tool"
done
unset NAVI_TEAM_IMAGE COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
files=(-f compose.yaml)
if [[ -f compose.override.yaml ]]; then files+=(-f compose.override.yaml); fi
compose() { docker compose -p navi-team --env-file image.env "${files[@]}" "$@"; }
image=$(compose config --images team)
[[ $image =~ ^(ghcr\.io/[a-z0-9._/-]+)@sha256:[0-9a-f]{64}$ ]] || die '需要发布包中锁定摘要的团队镜像。'
repo=${BASH_REMATCH[1]}
exec 7>.install.lock
flock -n 7 || die '安装正在进行。'
install -d -m 0755 deployment deployment/status
exec 8>deployment/status/worker.lock
flock -n 8 || die '部署服务正在处理请求，请稍后重试。'
exec 9>.update.lock
flock -n 9 || die '当前有更新或恢复正在执行。'
current=$(compose ps --all -q team)
if [[ -n $current ]]; then
  mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/navi-team"}}{{.Source}}{{end}}{{end}}' "$current")
  [[ $mount == "$(realpath -m data)" ]] || die '已有团队实例属于其他数据目录，请在原安装目录运行。'
  [[ $(docker inspect -f '{{.Config.Image}}' "$current") == "$image" ]] || die '现有实例的镜像与 image.env 不一致，请先按发布手册核对版本。'
fi
install -d -o 1000 -g 1000 -m 0700 data config deployment/requests
if [[ ! -e deployment.env ]]; then
  next=$(mktemp ./deployment.env.XXXXXX)
  trap 'rm -f -- "$next"' EXIT
  printf 'NAVI_DEPLOY_SOURCE=docker\nNAVI_DEPLOY_IMAGE=%s:team-stable\n' "$repo" > "$next"
  mv -- "$next" deployment.env
fi
docker image inspect "$image" >/dev/null 2>&1 || compose pull team

# A cancelled initial password prompt can leave an empty account table.
needs_admin=true
if [[ -s data/team.sqlite ]]; then
  if compose run --rm --no-deps -T --entrypoint node team --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync("/var/lib/navi-team/team.sqlite", { readOnly: true });
    if (!db.prepare("SELECT 1 FROM users LIMIT 1").get()) process.exitCode = 10;
    db.close();'; then
    needs_admin=false
  elif [[ $? != 10 ]]; then
    die '无法核对原有账号数据库。'
  fi
fi
if [[ $needs_admin == true ]]; then compose run --rm --no-deps team init admin; fi
compose up -d --pull never --wait --wait-timeout 120 team
unit="navi-team-deploy@$(systemd-escape --path "$(pwd -P)").service"
install -m 0644 navi-team-deploy@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$unit"
systemctl restart "$unit"
exec 9>&-
exec 8>&-

# Check from the same container and UID that serve the administrator page.
for attempt in {1..15}; do
  if systemctl is-active --quiet "$unit" && compose exec -T team node --input-type=module -e '
    import { access, constants } from "node:fs/promises";
    import { join } from "node:path";
    import { TeamDeployments } from "./team/deployments.mjs";
    const directory = process.env.NAVI_TEAM_DEPLOYMENT_DIR;
    if (!directory) process.exit(1);
    await access(join(directory, "requests"), constants.W_OK | constants.X_OK);
    if (!(await new TeamDeployments(directory).read()).enabled) process.exit(1);
  ' >/dev/null 2>&1; then
    echo '团队网站已就绪。管理员可登录「部署管理」使用一键部署。'
    exit 0
  fi
  sleep 1
done
die '部署服务未通过站点容器的就绪检查，请检查部署挂载和主机服务日志，然后重新运行安装。'
