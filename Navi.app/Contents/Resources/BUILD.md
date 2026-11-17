# 重建 macOS 启动器

此应用包使用 AGPL-3.0-only 许可，见同套件的 agent-workbench/LICENSE。
启动器对应源码为本目录的 launcher.c、launch.zsh 和相邻工作台的
agent-workbench/scripts/desktop-launcher.mjs。原生入口只启动本应用包的
launch.zsh，再由脚本定位相邻的工作台和本机 Node.js。

开发者在套件根目录可用 macOS Command Line Tools 重编译并本地签名：

```sh
/usr/bin/clang -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -O2 -Wall -Wextra \
  'Navi.app/Contents/Resources/launcher.c' -o 'Navi.app/Contents/MacOS/Qizhou'
/usr/bin/codesign --force --sign - 'Navi.app'
/usr/bin/codesign --verify --strict 'Navi.app'
```

Navi.icns 来源于相邻工作台的 public/icon.svg。此为本机使用的临时签名；
没有公证。使用者直接双击应用包，无需执行以上开发命令。
