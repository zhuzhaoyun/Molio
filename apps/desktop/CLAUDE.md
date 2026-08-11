# @molio/desktop — Electron Desktop Shell

Electron 桌面应用壳，包裹 `@molio/web` 构建产物，内嵌 `@molio/daemon` 提供后端服务。

## 架构

- **Electron main process** (`src/main.js`): 纯 JavaScript ESM，启动 daemon 子进程，创建 BrowserWindow
- **Daemon**: 作为 Electron 内置 Node.js 子进程运行，提供 API 和静态文件服务
- **Web UI**: 在 BrowserWindow 中加载，通过 HTTP 与 daemon 通信

### 开发模式 (app.isPackaged === false)

- Daemon 由 `pnpm dev:daemon` 单独启动 (tsx watch)
- Web UI 由 Vite dev server 提供 (HMR, port 5173)
- Electron 加载 `http://localhost:5173`

### 生产模式 (app.isPackaged === true)

- Electron 使用内置 Node.js (ELECTRON_RUN_AS_NODE) 启动 daemon 子进程
- Daemon 使用 `MOLIO_STATIC_DIR` 环境变量定位 web 构建产物
- Daemon 同时提供 API 和静态文件 (port 3100)
- Electron 加载 `http://localhost:3100`

### 为什么使用 ELECTRON_RUN_AS_NODE？

Electron 40 内置 Node.js 24.11.1。通过设置 `ELECTRON_RUN_AS_NODE=1` 环境变量，可以让 Electron 的二进制文件作为标准 Node.js 进程运行 daemon，无需用户单独安装 Node.js。

`better-sqlite3` 等原生模块在构建时通过 `prebuild-install --runtime electron` 下载 Electron 预编译二进制文件，确保在 Electron 的 Node.js 运行时中正确加载。

## 文件结构

```
src/
  main.js          Electron main process (ESM)
  preload.cjs      Preload script (contextBridge, IPC)
  updater.js       自动更新逻辑 (electron-updater)
  retry.js         重试退避策略
  logger.js        文件日志
  splash.html      启动画面 (daemon 启动时显示)
  monitoring.js    ARMS SDK 接入（initMonitoring；getUserId 参参 → beforeReport 注入 user.id）
  monitoring-sanitize.js  脱敏 + userId 注入纯函数（sanitizeBundle/injectUserId，可单测）
  crypto-server.js safeStorage 加密 HTTP 服务（用户模块 M4；127.0.0.1 随机端口，经 MOLIO_DESKTOP_CRYPTO_PORT 注入 daemon；safeStorage 经构造参数注入便于测试）
  auth-status-watch.js  轮询 daemon /api/auth/status（15s）维护 Molio userId，供 ARMS 注入
  daemon-metrics.js     轮询 daemon /api/health 上报内存指标到 ARMS
  wiki-fetcher.js / wiki-fetcher-login.js  飞书 wiki 抓取隐藏窗口 + 本机 HTTP server（crypto-server 的先例）
test/               测试用例 (node:test)，按源码模块子目录组织
  updater/         retry, updater-state-machine, updater-structure
  monitoring/      sanitize（含 injectUserId）
  crypto-server/   mock safeStorage + 真 http server（成功/503/400/413 矩阵）
  auth-status-watch/  mock fetch 驱动登录/登出/daemon 宕机状态转换
  daemon-metrics/  mock fetch 轮询行为
  logger.test.js
  daemon-startup.test.js
  window-open-handler.test.js
scripts/
  prepare-resources.mjs  构建时打包 daemon 和复制资源
  package.mjs            打包脚本
  fix-exe-metadata.mjs   修复 exe 元数据
```

### 用户模块 M4：token 加密 + ARMS userId（2026-08-11）

- **token 加密链路**：daemon 以 `ELECTRON_RUN_AS_NODE=1` 运行，无 Electron API。主进程起 `crypto-server.js`（端口 env 注入 daemon），daemon 侧 `core/auth/desktop-crypto.ts` RPC 加解密，落盘信封格式 `{v:1, encrypted}`。**`safeStorage.isEncryptionAvailable()=false`（Linux 无 keychain）时不起 server** → daemon 无 env → 明文基线（设计 §八 D3），避免"配置了 crypto 但每次加密都 503"导致 token 永不落盘。
- **ARMS userId**：SDK 无 setUser API（0.0.5–0.0.7 spike 验证），唯一注入点 = `beforeReport` 钩子置 `bundle.user.id`。`auth-status-watch.js` 轮询维护 userId（只在变化时回调；daemon 不可达不误判登出）。dev 模式 ARMS 整体跳过 → 轮询器也不起。

## 构建流程

1. `pnpm --filter @molio/contracts build` — 编译共享类型
2. `pnpm --filter @molio/daemon build` — 编译 daemon TypeScript
3. `pnpm --filter @molio/web build` — 构建 web Vite 产物
4. `node scripts/prepare-resources.mjs` — 使用 esbuild 打包 daemon，复制原生依赖和 web 构建
5. `npx electron-builder --win` — 打包为 Windows 安装程序

## 命令

```bash
pnpm dev          # 启动 Electron 开发模式 (需先启动 daemon + web)
pnpm build        # 构建所有依赖包 + 准备资源
pnpm package      # 打包为 Windows exe 安装程序
pnpm test         # 运行测试 (node:test, 自动扫描 test/**/*.test.js)
```

## 测试规范

遵循项目根目录 CLAUDE.md 中的**错误驱动测试**规则：每个 bug 在 `test/` 下按源码模块子目录添加复现测试用例。

- `test/updater/` → `src/retry.js`, `src/updater.js`（自动更新相关）
- `test/logger.test.js` → `src/logger.js`（日志模块）
- `test/daemon-startup.test.js` → `src/main.js`（daemon 启动）
- `test/window-open-handler.test.js` → `src/main.js`（窗口管理）

## 打包 (electron-builder)

- 目标平台: Windows x64
- 安装程序: NSIS (可选安装目录，非一键安装)
- daemon 编译产物 → resources/daemon/
- web 构建产物 → resources/web/
- 原生模块 (better-sqlite3) 通过 asarUnpack 处理
- `signAndEditExecutable: false` 跳过代码签名

## 核心原则

- **WebUI first**: 业务逻辑全部在 web 层，Electron 只是壳
- **E2E 测试直接测 web 层**，Electron 壳只测窗口管理和 daemon 启动
- 系统集成（托盘图标、文件关联、自动更新）后续阶段实现