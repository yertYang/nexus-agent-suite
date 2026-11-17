#!/usr/bin/env bash
# Run in the installed directory on Linux, as the maintenance operator.
set -euo pipefail
cd -- "$(dirname -- "$0")"
umask 077
die() { echo "$*" >&2; exit 1; }
digest='^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'
if [[ $# == 2 && $1 == --restore ]]; then
  mode=restore
elif [[ $# == 1 && $1 =~ $digest ]]; then
  mode=update
else
  die '用法：sudo ./update.sh 镜像@sha256:摘要 或 sudo ./update.sh --restore backups/备份名'
fi
[[ $EUID == 0 ]] || die '需要 root 读取并保留私有数据的所有权。'
unset NAVI_TEAM_IMAGE COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
exec 9>.update.lock
flock -n 9 || die '另一个更新仍在进行。'
[[ -d data && ! -L data && -f image.env && -f site.env && ! -L backups ]] || die '请在原安装目录运行，并检查数据、配置和备份目录。'
compose() { docker compose -p navi-team --env-file "$1" -f compose.yaml "${@:2}"; }
if [[ -f compose.override.yaml ]]; then
  compose() { docker compose -p navi-team --env-file "$1" -f compose.yaml -f compose.override.yaml "${@:2}"; }
fi
check_mount() {
  [[ -n $1 && $(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/navi-team"}}{{.Source}}{{end}}{{end}}' "$1") == "$(realpath data)" ]] || die '运行实例与此安装的数据挂载不一致。'
}
if [[ $mode == restore ]]; then
  backup=$(realpath -e -- "$2") || die '找不到所选备份。'
  [[ ${backup%/*} == "$(pwd -P)/backups" && -f $backup/complete && -s $backup/data/team.sqlite && -s $backup/image.env ]] || die '请选择本实例 backups 下标记为完整的更新备份。'
  check_mount "$(compose image.env ps --all -q team)"
  target=$(compose "$backup/image.env" config --images)
  active=$(compose image.env config --images)
  [[ $target =~ $digest && $active =~ $digest && ${target%@*} == "${active%@*}" ]] || die '备份没有指定当前仓库的镜像摘要。'
  # Stage and validate everything before interrupting the current service.
  docker image inspect "$target" >/dev/null 2>&1 || compose "$backup/image.env" pull team
  rescue=$(mktemp -d "backups/before-restore.XXXXXX")
  cp image.env "$rescue/before.env"
  cp "$backup/image.env" "$rescue/target.env"
  cp -a "$backup/data" "$rescue/prepared"
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true --read-only \
    --mount "type=bind,src=$(realpath "$rescue/prepared"),dst=/check" --entrypoint node "$target" \
    --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync("/check/team.sqlite",{readOnly:true}); if(db.prepare("PRAGMA quick_check(1)").get().quick_check!=="ok" || !db.prepare("SELECT 1 FROM users LIMIT 1").get()) process.exitCode=1; db.close();' \
    || die '备份数据库没有通过检查，未切换数据。'
  echo "恢复前的数据和镜像记录将保存在：$PWD/$rescue"
  compose image.env stop team
  mv -- data "$rescue/prior-data"
  if ! mv -- "$rescue/prepared" data; then
    mv -- "$rescue/prior-data" data
    die '无法切换数据目录，已放回原数据；服务未启动。'
  fi
  if ! compose "$rescue/target.env" up -d --force-recreate --pull never --wait --wait-timeout 90 team; then
    compose "$rescue/target.env" stop team
    die "恢复版本未就绪；服务已停止，原现场在 ${rescue}，所选备份未修改。"
  fi
  mv -f -- "$rescue/target.env" image.env
  echo "已恢复到 ${target}；请核对原账号、对话和共享文件后再开放流量。"
  exit 0
fi
[[ -s data/team.sqlite ]] || die '未找到本实例的账号数据库。'
current=$(compose image.env ps -q team)
[[ -n $current && $(docker inspect -f '{{.State.Health.Status}}' "$current") == healthy ]] || die '当前实例不健康或未运行；请先检查或恢复。'
old=$(docker inspect -f '{{.Config.Image}}' "$current")
[[ "$old" == "$(compose image.env config --images)" && "$old" == *@sha256:* ]] || die '运行版本与 image.env 不一致，未更新。'
[[ "$old" != "$1" ]] || { echo '已经运行指定版本。'; exit 0; }
[[ "${old%@*}" == "${1%@*}" ]] || die '镜像仓库与当前实例不一致。'
check_mount "$current"
next=$(mktemp ./image.env.next.XXXXXX)
trap 'rm -f -- "$next"' EXIT
printf 'NAVI_TEAM_IMAGE=%s\n' "$1" > "$next"
compose "$next" config --quiet
compose "$next" pull team
mkdir -p -m 700 backups
backup=$(mktemp -d "backups/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
cp image.env "$backup/image.env"
echo "停服备份位置：$PWD/$backup"
compose image.env stop team
# Nothing has touched the data yet: the old version is safe to restart if copying fails.
if ! { cp -a data "$backup/data" && touch "$backup/complete"; }; then
  compose image.env up -d --pull never --wait team
  die '备份失败；未切换版本。'
fi
if ! compose "$next" up -d --pull never --wait --wait-timeout 90 team; then
  compose "$next" stop team
  die "新版本未通过健康检查。已停止服务；保留现场。按 SERVER_RELEASE.md 从 $backup 恢复旧版本和同一时点的数据。"
fi
mv -f -- "$next" image.env
echo "已更新到 $1；备份：$PWD/$backup"
