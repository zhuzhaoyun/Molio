# electron-builder 国内镜像默认值兜底 —— 行为说明

> 对应：`apps/desktop/scripts/package.mjs`、`docs/desktop-dev-guide.md`「国内/信创网络打包前置配置」。本文描述**当前行为与设计取舍**，供维护和下次改动时查阅。

## 问题

桌面端打包（`pnpm package` / `desktop:run`）不是纯本地操作，electron-builder 要从网上下载三类构建期二进制，**默认源全部在 GitHub**：

| 下载内容 | 控制变量 | 默认源 |
|---|---|---|
| Electron 本体 zip | `ELECTRON_MIRROR` | `github.com/electron/electron` |
| NSIS、winCodeSign 等构建工具 | `ELECTRON_BUILDER_BINARIES_MIRROR` | `github.com/electron-userland/electron-builder-binaries` |
| better-sqlite3 的 Electron prebuild | `MOLIO_PREBUILD_HOST`（prepare-resources.mjs） | `github.com/better-sqlite3` releases |

国内/信创网络直连 GitHub 普遍超时：下载阶段长时间卡住后构建失败，报错是底层网络错误，不指向「该配镜像」这个真正的原因。

## 方案：默认值兜底，不覆盖显式配置

`apps/desktop/scripts/package.mjs` 在 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` **未设置时**注入 npmmirror 镜像默认值：

```
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://cdn.npmmirror.com/binaries/electron-builder-binaries/
```

行为约定：

- **已显式设置的值一律尊重、绝不覆盖**（遵循仓库「用户偏好处理规则」：用户配过就用用户的）。
- **所有本地打包入口统一收拢到 package.mjs**：`package` / `package:win|mac|linux` / `package:dir` / `run:unpacked` 全部经它转发给 electron-builder。只兜底 `package` 一个入口的话，日常更常用的 `pnpm desktop:run` 依然直连 GitHub，兜底形同虚设。
- better-sqlite3 prebuild 不在此列：它由 `prepare-resources.mjs` 下载，已内置「GitHub releases（重试 3 次）→ npmmirror（重试 2 次）」回退（PR #261），`MOLIO_PREBUILD_HOST` 可显式指定第一来源、跳过 GitHub 尝试。

## 刻意取舍

- **CI 发布不受影响是刻意的。** release.yml 直接调用 `npx electron-builder`、不经过 package.mjs，发布产物的下载来源仍是 GitHub 官方源。本地开发求顺（镜像默认值开箱即用），正式发布求源（官方渠道），两条路径互不干扰。
- **兜底做在脚本里而不是文档里**，是因为这类故障的报错（网络超时）离根因（该配镜像）太远，指望每个人打包前翻文档手动配三个变量不现实。
- **有一环脚本够不到**：`pnpm install` 阶段 electron 包的 postinstall 下载发生在 package.mjs 介入之前，只能提前手动设好 `ELECTRON_MIRROR` 再 install。这条写在 dev-guide 的前置配置小节里。

## 已知坑：pnpm 孤儿符号链接

移除依赖或切换分支后，pnpm 不会清理 node_modules 里残留的孤儿符号链接（指向已不存在的 pnpm store 路径）。electron-builder 打包时逐个 stat 文件，遇到悬挂链接即报 `ENOENT: no such file or directory, stat '...node_modules...'` 中断——实测一次依赖移除可留下上百个悬挂链接。

排查与修法见 dev-guide 常见问题第 7 条（`find ... -type l ! -exec test -e {} \; -print` 扫失效链接；删全部 node_modules 重装）。**打包报 stat ENOENT 且路径在 node_modules 里时，先扫悬挂链接，再怀疑别的。**
