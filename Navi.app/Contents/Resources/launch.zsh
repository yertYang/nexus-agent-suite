#!/bin/zsh -f
# SPDX-License-Identifier: AGPL-3.0-only
emulate -LR zsh
setopt NULL_GLOB
umask 077
unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE BASH_ENV ENV ZDOTDIR
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

bundle_dir="${0:A:h:h:h}"
suite_dir="${bundle_dir:h}"
launcher="$suite_dir/agent-workbench/scripts/desktop-launcher.mjs"

if [[ ! -r "$launcher" ]]; then
  /usr/bin/osascript -e 'display dialog "找不到套件中的 Navi。请将“Navi.app”和“agent-workbench”保留在同一个文件夹后再打开。" with title "Navi" buttons {"好"} default button "好" with icon caution' >/dev/null 2>&1
  exit 1
fi

typeset -a runtimes
runtimes=(
  "$bundle_dir/Contents/Resources/runtime/bin/node"
  "$HOME"/.nvm/versions/node/v*/bin/node(On)
  "$HOME"/.volta/tools/image/node/*/bin/node(On)
  /opt/homebrew/opt/node@24/bin/node
  /opt/homebrew/bin/node
  /usr/local/opt/node@24/bin/node
  /usr/local/bin/node
)
for node_bin in "${runtimes[@]}"; do
  if [[ -x "$node_bin" ]] && "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' </dev/null >/dev/null 2>&1; then
    exec "$node_bin" "$launcher" </dev/null >/dev/null 2>&1
  fi
done

/usr/bin/osascript -e '
set picked to button returned of (display dialog "此电脑需要 Node.js 24 或更高版本。请从 Node.js 官网安装 macOS 版本，然后再次双击“Navi.app”。" with title "Navi" buttons {"前往下载", "好"} default button "好" with icon caution)
if picked is "前往下载" then open location "https://nodejs.org/zh-cn/download"
' >/dev/null 2>&1
exit 1
