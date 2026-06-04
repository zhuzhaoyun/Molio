# KGE Electron 桌面应用 — 开发环境构建与运行指南

## 目录

- [前置条件](#前置条件)
- [项目结构](#项目结构)
- [开发模式运行](#开发模式运行)
- [构建流程详解](#构建流程详解)
- [打包为安装包](#打包为安装包)
- [生产模式运行（未打包）](#生产模式运行未打包)
- [常见命令速查](#常见命令速查)
- [常见问题与排查](#常见问题与排查)
- [生产环境 cwd 注意事项](#生产环境-cwd-注意事项)

---

## 前置条件

### 必需环境

| 工具 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | ≥ 20.x | 系统安装的 Node.js，daemon 依赖它运行 |
| pnpm | ≥ 9.x | 包管理器 |
| Git | 任意版本 | 用于版本管理（可选，影响版本号显示） |

### 安装依赖

```bash
# 在项目根目录执行
pnpm install
```

这会安装所有 workspace 包的依赖，包括 `apps/desktop` 的 `electron` 和 `electron-builder`。

---

## 项目结构

```
knowledge-growth-engine/
├── packages/
│   └── contracts/          @kge/contracts  — 共享类型定义
├── apps/
│   ├── daemon/             @kge/daemon     — Hono HTTP 服务 (port 3100)
│   ├── web/                @kge/web        — Vite + React 前端 (port 5173)
│   └── desktop/            @kge/desktop    — Electron 桌面壳
│       ├── src/
│       │   ├── main.js         主进程：启动 daemon + 创建窗口
│       │   ├── preload.js      预加载脚本：暴露 API 给渲染进程
│       │   └── splash.html     启动画面
│       ├── scripts/
│       │   └── prepare-resources.mjs   构建脚本：打包 daemon + 复制 web 产物
│       ├── resources/          构建产物目录（prepare 脚本生成）
│       │   ├── daemon/         daemon.js + node_modules（better-sqlite3）
│       │   └── web/            Vite 构建产物（index.html + assets/）
│       └── dist/               electron-builder 输出目录
│           ├── win-unpacked/   可直接运行的未打包版本
│           └── *.exe           NSIS 安装包
└── package.json            根级脚本入口
```

---

## 开发模式运行

开发模式下，三个服务同时运行，Electron 加载 Vite dev server（支持 HMR 热更新）：

```bash
pnpm dev:desktop
```

这个命令通过 `concurrently` 同时启动三个进程：

| 进程 | 命令 | 端口 | 说明 |
|------|------|------|------|
| daemon | `pnpm --filter @kge/daemon dev` | 3100 | `tsx watch` 热重载 |
| web | `pnpm --filter @kge/web dev` | 5173 | Vite dev server + HMR |
| desktop | `pnpm --filter @kge/desktop dev` | — | `electron .` 启动 Electron |

### 开发模式的工作方式

```
┌─────────────────────────────────────────────────┐
│  Electron (apps/desktop)                        │
│  ┌───────────────────────────────────────────┐  │
│  │  BrowserWindow                             │  │
│  │  → loadURL('http://localhost:5173')       │  │
│  │  → Vite HMR 热更新                        │  │
│  └──────────────────┬────────────────────────┘  │
│                     │ HTTP/SSE                  │
│  ┌──────────────────▼────────────────────────┐  │
│  │  Daemon (独立进程，tsx watch)              │  │
│  │  → http://localhost:3100                   │  │
│  │  → 代码改动自动重启                        │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**注意**：开发模式下 Electron 不启动 daemon（daemon 由 dev:desktop 的 concurrently 单独管理），这样 daemon 代码改动时可以自动重启，不受 Electron 生命周期影响。

### 单独运行某个服务

```bash
# 只运行 daemon
pnpm dev:daemon

# 只运行 web UI
pnpm dev:web

# 只运行 daemon + web（不启动 Electron）
pnpm dev
```

---

## 构建流程详解

构建桌面应用需要依次构建四个部分：

```bash
pnpm build:desktop
```

这个命令实际执行的步骤：

```
Step 1: pnpm --filter @kge/contracts build
        → tsc 编译共享类型到 packages/contracts/dist/

Step 2: pnpm --filter @kge/daemon build
        → tsc 编译 daemon 到 apps/daemon/dist/src/

Step 3: pnpm --filter @kge/web build
        → vite build 编译前端到 apps/web/dist/

Step 4: node scripts/prepare-resources.mjs
        → esbuild 打包 daemon 为单文件
        → 复制 better-sqlite3 native 模块
        → 复制 web 构建产物
```

### prepare-resources.mjs 做了什么

这个脚本是构建的核心，它把 daemon 和 web 的产物准备到 Electron 可以打包的格式：

**1. Daemon 打包（esbuild）**

```
apps/daemon/dist/src/index.js (tsc 输出)
        ↓ esbuild (bundle, node20, esm)
apps/desktop/resources/daemon/daemon.js (单文件)
```

`better-sqlite3` 被标记为 `external`（不打包），单独复制到 `resources/daemon/node_modules/`。

**2. Web 产物复制**

```
apps/web/dist/ (Vite 输出)
        ↓ 复制 + 修复资源路径
apps/desktop/resources/web/ (index.html + assets/)
```

脚本会修复 `index.html` 中的资源路径：`/assets/` → `assets/`（去掉前导斜杠，确保相对路径加载正确）。

**3. Native 模块复制**

```
node_modules/better-sqlite3/
        ↓ 只复制必要文件
resources/daemon/node_modules/better-sqlite3/
  ├── package.json
  ├── lib/
  └── build/Release/*.node    ← native 二进制
```

同时复制 `bindings` 和 `file-uri-to-path`（better-sqlite3 的依赖）。

---

## 打包为安装包

```bash
# 完整流程：构建 + 打包
pnpm package
```

这个命令等价于：

```bash
pnpm build                          # 构建所有包
pnpm --filter @kge/desktop package  # electron-builder --win
```

`electron-builder` 会：

1. 读取 `apps/desktop/package.json` 中的 `build` 配置
2. 将 `src/` 打包进 `app.asar`
3. 将 `resources/` 复制到 `resources/`（通过 `extraResources`）
4. 将 `.node` 文件从 asar 中解包（通过 `asarUnpack`）
5. 生成 NSIS 安装包 `.exe` 到 `apps/desktop/dist/`

### 只生成未打包目录（不生成安装包）

```bash
pnpm package:dir
```

生成 `apps/desktop/dist/win-unpacked/`，里面包含可直接运行的 exe，无需安装。适合快速测试。

---

## 生产模式运行（未打包）

```bash
pnpm desktop:run
```

等价于：

```bash
pnpm build && pnpm --filter @kge/desktop run:unpacked
```

这会构建所有包，然后生成未打包版本并提示运行路径：

```
Run: ./dist/win-unpacked/Knowledge Growth Engine.exe
```

### 生产模式的工作方式

```
┌─────────────────────────────────────────────────┐
│  Knowledge Growth Engine.exe                    │
│  ┌───────────────────────────────────────────┐  │
│  │  主进程 (main.js)                         │  │
│  │  → findSystemNode() 查找系统 Node.js      │  │
│  │  → spawn daemon.js (resources/daemon/)    │  │
│  │  → createWindow()                         │  │
│  └──────────────────┬────────────────────────┘  │
│                     │ HTTP/SSE                  │
│  ┌──────────────────▼────────────────────────┐  │
│  │  Daemon (Node.js 子进程)                  │  │
│  │  → http://localhost:3100                   │  │
│  │  → 同时提供 API 和静态文件                 │  │
│  │  → KGE_STATIC_DIR = resources/web/        │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │  BrowserWindow                             │  │
│  │  → loadURL('http://localhost:3100')       │  │
│  │  → daemon 同时提供 API 和 Web UI           │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**关键区别**：

| | 开发模式 | 生产模式 |
|---|---|---|
| Daemon | 独立进程（tsx watch） | Electron 子进程（Node.js 运行 daemon.js） |
| Web UI | Vite dev server (:5173) | Daemon 提供静态文件 (:3100) |
| 加载地址 | `http://localhost:5173` | `http://localhost:3100` |
| 热更新 | ✅ HMR + tsx watch | ❌ 需要重新打包 |
| DevTools | 自动打开 | 不打开 |

---

## 常见命令速查

```bash
# ─── 开发 ───
pnpm dev              # daemon + web（不启动 Electron）
pnpm dev:desktop      # daemon + web + Electron（完整开发环境）
pnpm dev:daemon       # 只运行 daemon
pnpm dev:web          # 只运行 web UI

# ─── 构建 ───
pnpm build            # 构建所有包（contracts + daemon + web + desktop）
pnpm build:desktop    # 构建桌面应用（包含 prepare-resources）

# ─── 打包 ───
pnpm package          # 构建 + 打包为 NSIS 安装包
pnpm package:dir      # 构建 + 生成未打包目录（快速测试）
pnpm desktop:run      # 构建 + 生成未打包版本 + 提示运行路径

# ─── 测试 ───
pnpm test             # 运行 daemon 测试
pnpm typecheck        # 全项目类型检查
```

---

## 常见问题与排查

### 1. `pnpm dev:desktop` 启动后 Electron 白屏

**原因**：Vite dev server 还没就绪，Electron 已经开始加载 `http://localhost:5173`。

**解决**：等几秒，Vite 启动后会自动加载。如果持续白屏，检查 5173 端口是否被占用：

```bash
netstat -ano | findstr 5173
```

### 2. `better-sqlite3` 加载失败（ABI mismatch）

**原因**：Electron 内嵌的 Node.js 版本和系统 Node.js 版本不同，native 模块 ABI 不兼容。

**解决**：KGE 已处理此问题 — 生产模式使用系统 Node.js 运行 daemon（`findSystemNode()`），不通过 Electron 内嵌的 Node.js 加载 native 模块。确保系统已安装 Node.js ≥ 20.x。

### 3. 打包后 daemon 启动失败

**排查步骤**：

```bash
# 1. 检查 resources 是否正确准备
ls apps/desktop/resources/daemon/
# 应该有: daemon.js, node_modules/

# 2. 手动运行 daemon 看报错
node apps/desktop/resources/daemon/daemon.js
```

### 4. `electron-builder` 报错 `cannot find module`

**原因**：依赖没安装或 `pnpm install` 没完成。

**解决**：

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

### 5. 打包的 exe 运行时闪退

**排查**：用命令行启动看日志：

```bash
# 未打包版本
./apps/desktop/dist/win-unpacked/"Knowledge Growth Engine".exe

# 或者在 cmd 中运行看输出
cd apps/desktop/dist/win-unpacked
"Knowledge Growth Engine".exe
```

### 6. 端口 3100 或 5173 被占用

```bash
# 查找占用端口的进程
netstat -ano | findstr 3100
netstat -ano | findstr 5173

# 杀掉对应进程
taskkill /PID <进程号> /F
```

---

## 生产环境 cwd 注意事项

在 Electron 打包版本中，`process.cwd()` 的值**不可靠** — 它可能是安装目录、系统目录、或者用户启动 exe 时所在的目录。

### 问题场景

如果 daemon 或其他模块在生产环境中使用 `process.cwd()` 来定位文件或执行命令（如 `git describe`），可能会找不到目标路径。

### 解决方案

在 `main.js` 中启动 daemon 时，**显式设置 `cwd`** 为应用的 resources 目录：

```javascript
// apps/desktop/src/main.js — startDaemonProduction()

function startDaemonProduction() {
  const daemonEntry = path.join(process.resourcesPath, 'daemon', 'daemon.js');
  const webStaticDir = path.join(process.resourcesPath, 'web');
  const nodeExe = findSystemNode();

  return new Promise((resolve, reject) => {
    daemonProcess = spawn(nodeExe, [daemonEntry], {
      // ▼ 关键：显式设置 cwd，不依赖 process.cwd()
      cwd: path.dirname(daemonEntry),
      env: {
        ...process.env,
        KGE_PORT: '3100',
        KGE_STATIC_DIR: webStaticDir,
      },
      stdio: 'pipe',
    });
    // ...
  });
}
```

### 为什么用 `path.dirname(daemonEntry)` 而不是 `app.getAppPath()`

| 路径 | 值（打包后） | 适用场景 |
|------|------------|---------|
| `process.cwd()` | 不确定（取决于启动方式） | ❌ 不要用于定位资源 |
| `app.getAppPath()` | `C:\Users\...\AppData\Local\KGE\resources\app.asar` | 定位 asar 内的文件 |
| `process.resourcesPath` | `C:\Users\...\AppData\Local\KGE\resources` | 定位 resources 下的文件 |
| `path.dirname(daemonEntry)` | `C:\Users\...\AppData\Local\KGE\resources\daemon` | daemon 进程的工作目录 |

daemon 的 `cwd` 设为 `resources/daemon/` 目录是合理的，因为：
- daemon 如果需要读取相对路径的配置文件，应该在自身所在目录
- daemon spawn 的 agent CLI 进程会继承这个 cwd，但 KGE 的设计是通过 `opts.cwd`（项目的 `localPath`）来指定 agent 的工作目录，不依赖 daemon 的 cwd

### 需要在 daemon 中获取应用路径时

如果 daemon 代码中需要获取 Electron 应用的安装路径，通过环境变量传递：

```javascript
// main.js — 启动 daemon 时注入
env: {
  ...process.env,
  KGE_PORT: '3100',
  KGE_STATIC_DIR: webStaticDir,
  KGE_APP_DIR: app.getAppPath(),           // 应用路径
  KGE_RESOURCES_DIR: process.resourcesPath, // resources 路径
  KGE_USER_DATA_DIR: app.getPath('userData'), // 用户数据路径
}
```

daemon 中使用：

```typescript
// apps/daemon/src/index.ts
const appDir = process.env.KGE_APP_DIR ?? process.cwd();
const resourcesDir = process.env.KGE_RESOURCES_DIR ?? process.cwd();
const userDataDir = process.env.KGE_USER_DATA_DIR ?? process.cwd();
```

这样 daemon 无论在开发模式还是生产模式，都能通过环境变量获取正确的路径，不依赖 `process.cwd()`。
