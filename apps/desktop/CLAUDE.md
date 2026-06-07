# @molio/desktop — Electron Desktop Shell

Electron 桌面应用壳，包裹 `@molio/web` 构建产物，内嵌 `@molio/daemon` 提供后端服务。

## 架构

- **Electron main process** (`src/main.js`): 纯 JavaScript ESM，启动 daemon 子进程，创建 BrowserWindow
- **Daemon**: 作为系统 Node.js 子进程运行，提供 API 和静态文件服务
- **Web UI**: 在 BrowserWindow 中加载，通过 HTTP 与 daemon 通信

### 开发模式 (app.isPackaged === false)

- Daemon 由 `pnpm dev:daemon` 单独启动 (tsx watch)
- Web UI 由 Vite dev server 提供 (HMR, port 5173)
- Electron 加载 `http://localhost:5173`

### 生产模式 (app.isPackaged === true)

- Electron 使用系统 Node.js 启动 daemon 子进程
- Daemon 使用 `MOLIO_STATIC_DIR` 环境变量定位 web 构建产物
- Daemon 同时提供 API 和静态文件 (port 3100)
- Electron 加载 `http://localhost:3100`

### 为什么使用系统 Node.js 而不是 Electron 的 Node.js？

Electron 33 内置 Node.js 20.18.0 (ABI 130)，而系统 Node.js 是 22.x (ABI 127)。
`better-sqlite3` 等原生模块是为系统 Node.js 编译的，直接在 Electron 的 Node.js 中加载会产生 ABI 不匹配。
使用系统 Node.js 运行 daemon 可以避免这个问题，但需要用户系统已安装 Node.js。

## 文件结构

```
src/
  main.js        Electron main process (ESM)
  preload.js     Preload script (空，contextIsolation 启用)
  splash.html    启动画面 (daemon 启动时显示)
scripts/
  prepare-resources.mjs  构建时打包 daemon 和复制资源
```

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
```

## 打包 (electron-builder)

- 目标平台: Windows x64
- 安装程序: NSIS (可选安装目录，非一键安装)
- daemon 编译产物 → resources/daemon/
- web 构建产物 → resources/web/
- 原生模块 (better-sqlite3) 通过 asarUnpack 处理
- `signAndEditExecutable: false` 跳过代码签名

## 核心原则

- **WebUI first**: 业务逻辑全部在 web 层，Electron 只是壳
- **E2E 测试直接测 web 层**，Electron 壳只测窗口管理
- 系统集成（托盘图标、文件关联、自动更新）后续阶段实现
