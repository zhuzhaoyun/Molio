# Molio 自动更新实施指南

基于 Molio 当前代码库的实际状态，逐步实现 Electron 桌面应用的自动更新功能。

## 当前状态

Molio 的 Electron 桌面应用已经具备：

- ✅ `electron-builder` 已安装并配置（`apps/desktop/package.json` 的 `build` 字段）
- ✅ NSIS 安装包可以正常打包（`pnpm package`）
- ✅ Daemon 已打包到 `resources/daemon/`
- ✅ Web UI 已打包到 `resources/web/`
- ✅ 主进程 `src/main.js` 已实现 daemon 启停和窗口管理

还需要添加：

- ❌ `electron-updater` 依赖
- ❌ `publish` 配置（告诉 electron-updater 去哪里检查更新）
- ❌ 自动更新逻辑（`updater.js`）
- ❌ Preload IPC 桥接（暴露 updater API 给渲染进程）
- ❌ Web UI 更新通知组件
- ❌ GitHub Actions 发布工作流
- ❌ 版本号从 git tag 派生

---

## 实施步骤

### 第一步：安装 electron-updater

```bash
cd apps/desktop
pnpm add electron-updater
```

### 第二步：修改 package.json — 添加 publish 配置

在 `apps/desktop/package.json` 的 `build` 字段中添加 `publish` 配置：

```jsonc
// apps/desktop/package.json
{
  "build": {
    "appId": "com.molio.desktop",
    "productName": "Knowledge Growth Engine",
    // ... 其他已有配置保持不变 ...

    // ▼ 新增 publish 配置
    "publish": {
      "provider": "github",
      "owner": "你的GitHub用户名",
      "repo": "knowledge-growth-engine",
      "releaseType": "release"
    }
  }
}
```

**说明**：`publish` 告诉 electron-updater 去哪个 GitHub 仓库的 Release 检查更新。`releaseType: "release"` 必须是正式发布（不能是 draft），否则 electron-updater 检测不到。

### 第三步：创建 updater.js — 自动更新逻辑

```javascript
// apps/desktop/src/updater.js
import { autoUpdater } from 'electron-updater';
import { app, ipcMain } from 'electron';

// 静默后台更新：发现新版本后自动下载，下载完通知用户
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const STARTUP_DELAY = 5_000;        // 启动后 5 秒检查
const POLL_INTERVAL = 60 * 60 * 1000; // 每小时检查

// 防重复检查
let inFlightCheck = null;

function checkForUpdatesOnce() {
  if (inFlightCheck) return inFlightCheck;
  const p = autoUpdater.checkForUpdates()
    .then((result) => {
      void result?.downloadPromise?.catch((err) => {
        console.error('Download failed:', err);
      });
      return result;
    })
    .finally(() => {
      if (inFlightCheck === p) inFlightCheck = null;
    });
  inFlightCheck = p;
  return p;
}

export function setupAutoUpdater(getMainWindow) {
  // 事件：发现新版本
  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] v${info.version} available`);
    getMainWindow()?.webContents.send('updater:update-available', {
      version: info.version,
    });
  });

  // 事件：下载进度
  autoUpdater.on('download-progress', (progress) => {
    getMainWindow()?.webContents.send('updater:download-progress', {
      percent: progress.percent,
    });
  });

  // 事件：下载完成
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] v${info.version} downloaded`);
    getMainWindow()?.webContents.send('updater:update-downloaded', {
      version: info.version,
    });
  });

  // 事件：错误
  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err);
  });

  // IPC：手动检查
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await checkForUpdatesOnce();
      const currentVersion = app.getVersion();
      return {
        ok: true,
        currentVersion,
        latestVersion: result?.updateInfo?.version ?? currentVersion,
        available: result?.isUpdateAvailable ?? false,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // IPC：安装并重启
  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // 启动后延迟检查
  setTimeout(() => { checkForUpdatesOnce().catch(console.error); }, STARTUP_DELAY);

  // 定时轮询
  setInterval(() => { checkForUpdatesOnce().catch(console.error); }, POLL_INTERVAL);
}
```

### 第四步：修改 main.js — 集成自动更新

在 `apps/desktop/src/main.js` 中添加两行代码：

```javascript
// apps/desktop/src/main.js

// ▼ 新增导入
import { setupAutoUpdater } from './updater.js';

// ... 现有代码保持不变 ...

// 在 app.whenReady() 的回调中，createWindow() 之后添加：
app.whenReady().then(async () => {
  // ... 现有的 daemon 启动和窗口创建代码 ...

  // ▼ 新增：设置自动更新（只在打包版本中启用）
  if (app.isPackaged) {
    setupAutoUpdater(() => mainWindow);
  }
});
```

**说明**：`app.isPackaged` 判断确保只在打包版本中检查更新。开发环境不检查，避免干扰。

同时添加 app-info IPC（供 preload 获取版本信息）：

```javascript
// 在 main.js 中添加（app.whenReady 之前或之后都行）
import { ipcMain } from 'electron';  // 如果还没导入

ipcMain.on('app:get-info', (event) => {
  const platform = process.platform;
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  event.returnValue = {
    version: app.getVersion(),
    os,
  };
});
```

### 第五步：修改 preload.js — 暴露 updater API

```javascript
// apps/desktop/src/preload.js
import { contextBridge, ipcRenderer } from 'electron';

// 同步获取应用信息
function fetchAppInfo() {
  try {
    return ipcRenderer.sendSync('app:get-info');
  } catch {
    return { version: 'unknown', os: 'unknown' };
  }
}

const desktopAPI = {
  platform: process.platform,
  appInfo: fetchAppInfo(),
};

// ▼ 新增 updater API
const updaterAPI = {
  onUpdateAvailable: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on('updater:update-available', handler);
    return () => ipcRenderer.removeListener('updater:update-available', handler);
  },
  onDownloadProgress: (callback) => {
    const handler = (_, progress) => callback(progress);
    ipcRenderer.on('updater:download-progress', handler);
    return () => ipcRenderer.removeListener('updater:download-progress', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on('updater:update-downloaded', handler);
    return () => ipcRenderer.removeListener('updater:update-downloaded', handler);
  },
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
};

contextBridge.exposeInMainWorld('__electron__', desktopAPI);
contextBridge.exposeInMainWorld('updater', updaterAPI);  // ▼ 新增
```

### 第六步：添加 TypeScript 类型声明

在 `apps/web/src/` 中创建类型声明文件，让 Web UI 代码能识别 `window.updater`：

```typescript
// apps/web/src/types/electron.d.ts

interface UpdaterAPI {
  onUpdateAvailable: (callback: (info: { version: string }) => void) => () => void;
  onDownloadProgress: (callback: (progress: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  installUpdate: () => Promise<void>;
  checkForUpdates: () => Promise<
    | { ok: true; currentVersion: string; latestVersion: string; available: boolean }
    | { ok: false; error: string }
  >;
}

interface DesktopAPI {
  platform: string;
  appInfo: { version: string; os: string };
}

declare global {
  interface Window {
    updater?: UpdaterAPI;
    __electron__?: DesktopAPI;
  }
}

export {};
```

### 第七步：创建更新通知组件

```tsx
// apps/web/src/components/UpdateNotification.tsx
import { useEffect, useState } from 'react';

type UpdateState =
  | { status: 'idle' }
  | { status: 'ready'; version: string };

export function UpdateNotification() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.updater) return;  // 非 Electron 环境不显示
    const cleanup = window.updater.onUpdateDownloaded((info) => {
      setState({ status: 'ready', version: info.version });
      setDismissed(false);
    });
    return cleanup;
  }, []);

  // 非 Electron 环境或没有更新时不渲染
  if (!window.updater) return null;
  if (state.status === 'idle' || dismissed) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 16,
      right: 16,
      zIndex: 50,
      width: 320,
      padding: 16,
      borderRadius: 8,
      border: '1px solid var(--border)',
      backgroundColor: 'var(--background)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    }}>
      <button
        onClick={() => setDismissed(true)}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        ✕
      </button>
      <p style={{ fontWeight: 600, fontSize: 14, margin: 0 }}>更新就绪</p>
      <p style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4 }}>
        v{state.version} 将在重启后应用
      </p>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button
          onClick={() => setDismissed(true)}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--background)',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          稍后
        </button>
        <button
          onClick={() => window.updater?.installUpdate()}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: 'none',
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          立即重启
        </button>
      </div>
    </div>
  );
}
```

### 第八步：在 App 中挂载更新通知

在 `apps/web/src/App.tsx`（或根组件）中添加：

```tsx
// apps/web/src/App.tsx
import { UpdateNotification } from './components/UpdateNotification';

function App() {
  return (
    <>
      {/* ... 现有的应用内容 ... */}
      <UpdateNotification />
    </>
  );
}
```

### 第九步：创建 GitHub Actions 发布工作流

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - "v*.*.*"
      - "!v*-dirty*"

permissions:
  contents: write

jobs:
  desktop:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

      - name: Package Desktop installer
        working-directory: apps/desktop
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
        run: npx electron-builder --win --publish always
```

**关键配置说明**：

- `fetch-depth: 0` — 需要完整 git 历史，否则 `git describe` 找不到 tag
- `GITHUB_TOKEN` — GitHub Actions 自动提供，用于上传 Release 资产
- `CSC_IDENTITY_AUTO_DISCOVERY: "false"` — 暂时不签名
- `--publish always` — 强制上传到 GitHub Release

### 第十步（可选）：版本号从 git tag 派生

如果需要版本号自动跟随 git tag（而不是手动改 package.json），修改打包命令：

在 `.github/workflows/release.yml` 中添加版本派生步骤：

```yaml
      - name: Derive version from git tag
        id: version
        shell: bash
        run: |
          raw=$(git describe --tags --always --dirty)
          version=${raw#v}
          echo "version=$version" >> "$GITHUB_OUTPUT"

      - name: Package Desktop installer
        working-directory: apps/desktop
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
        run: npx electron-builder --win --publish always -c.extraMetadata.version=${{ steps.version.outputs.version }}
```

**`-c.extraMetadata.version=X.Y.Z`** 在打包时覆盖 package.json 的 version 字段，不修改源文件。

---

## 验证流程

```bash
# 1. 提交所有改动到 main 分支
git add -A && git commit -m "feat(desktop): add auto-update support"
git push origin main

# 2. 打第一个版本 tag
git tag v0.1.0
git push origin v0.1.0
# → GitHub Actions 自动构建 → 上传到 GitHub Release

# 3. 下载 v0.1.0 安装包，安装并运行
# → 启动后 5 秒检查更新 → 已是最新

# 4. 做一些改动，打新版本 tag
git tag v0.2.0
git push origin v0.2.0
# → GitHub Actions 自动构建 → 上传到 GitHub Release

# 5. 启动 v0.1.0
# → 5 秒后检测到 v0.2.0
# → 后台下载（用户无感知）
# → 下载完成 → 右下角弹出通知
# → 用户点击"立即重启" → 自动安装并重启
# → v0.2.0 运行
```

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/desktop/package.json` | 修改 | 添加 `electron-updater` 依赖 + `publish` 配置 |
| `apps/desktop/src/updater.js` | 新增 | 自动更新核心逻辑 |
| `apps/desktop/src/main.js` | 修改 | 导入 setupAutoUpdater + 添加 app-info IPC |
| `apps/desktop/src/preload.js` | 修改 | 暴露 updater API 到 window |
| `apps/web/src/types/electron.d.ts` | 新增 | TypeScript 类型声明 |
| `apps/web/src/components/UpdateNotification.tsx` | 新增 | 更新就绪通知组件 |
| `apps/web/src/App.tsx` | 修改 | 挂载 UpdateNotification |
| `.github/workflows/release.yml` | 新增 | GitHub Actions 发布工作流 |

---

## 注意事项

1. **开发环境不会触发更新检查** — `setupAutoUpdater` 只在 `app.isPackaged` 为 true 时调用
2. **Web 模式下 updater 不存在** — `window.updater` 只在 Electron 环境中存在，组件中有 `if (!window.updater) return null` 保护
3. **GitHub Release 必须是 published 状态** — draft Release 不会被 electron-updater 检测到
4. **首次发布需要手动创建 Release** — 或者确保 GitHub Actions 有 `contents: write` 权限，electron-builder 会自动创建
5. **安装包签名** — 当前未配置签名，Windows 会弹 SmartScreen 警告。正式发版时可配置 `CSC_LINK` 环境变量
6. **better-sqlite3 的 .node 文件** — 已在 `asarUnpack` 中配置，确保 native 模块不被压缩进 asar
