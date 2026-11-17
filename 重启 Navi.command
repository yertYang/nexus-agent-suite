#!/bin/zsh -f
# Restart only the desktop workbench belonging to this copy of the suite.
set -eu
root=${0:A:h}
daemon="$root/agent-workbench/scripts/launch.mjs"
app="$root/Navi.app"
[[ -f "$daemon" && -d "$app" ]] || { print -u2 '请将此文件保留在 Navi 套件根目录。'; exit 1; }
[[ $# == 0 || ( $# == 1 && $1 == --check ) ]] || exit 2
listener() { /usr/sbin/lsof -nP -a -iTCP:17880 -sTCP:LISTEN -t | /usr/bin/sort -u; }
pid=$(listener)
if [[ -n "$pid" ]]; then
  [[ "$pid" == <-> ]] || { print -u2 '端口上有多个进程，未重启。'; exit 1; }
  identity=$(/bin/ps -ww -p "$pid" -o command=)
  owner=$(/bin/ps -p "$pid" -o uid=)
  [[ "${owner//[[:space:]]/}" == "$EUID" && "$identity" == *"/node $daemon desktop" ]] || {
    print -u2 '端口上的进程不属于当前套件的桌面工作台，未停止。'; exit 1;
  }
fi
if [[ ${1:-} == --check ]]; then
  print -- "检查结束（未重启）：${pid:-未发现桌面工作台进程}"; exit 0
fi
if [[ -n "$pid" ]]; then
  print '正在停止当前套件的桌面工作台…'
  kill -TERM "$pid"
  for i in {1..80}; do
    kill -0 "$pid" 2>/dev/null || break
    /bin/sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then print -u2 '旧工作台尚未退出，未启动新实例。'; exit 1; fi
fi
print '正在打开 Navi。工作台就绪后，请在扩展中重新配对。'
exec /usr/bin/open -n "$app"
