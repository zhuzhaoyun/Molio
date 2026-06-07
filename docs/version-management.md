# 版本管理与自动更新

本文档包含两部分：

1. **Multica 调研**：对 Multica 项目版本管理机制的完整分析，包含源码级细节
2. **Molio 实施方案**：Molio 桌面应用的版本管理和自动更新实施指南

---

## 目录

- [第一部分：Multica 调研](#第一部分multica-调研)
  - [整体架构](#整体架构)
  - [版本号管理](#版本号管理-1)
  - [构建脚本 package.mjs](#构建脚本-packagemjs)
  - [electron-builder 配置](#electron-builder-配置-1)
  - [自动更新 updater.ts](#自动更新-updaterts)
  - [UI 通知组件](#ui-通知组件-1)
  - [设置页更新标签](#设置页更新标签-1)
  - [Preload IPC 桥接](#preload-ipc-桥接-1)
  - [Daemon 版本协调](#daemon-版本协调)
  - [客户端身份标识](#客户端身份标识)
  - [GitHub Actions 发布流程](#github-actions-发布流程-1)
  - [关键文件索引](#关键文件索引)
- [第二部分：Molio 实施方案](#第二部分molio-实施方案)
  - [方案选型](#方案选型)
  - [版本号管理](#版本号管理-2)
  - [构建与发布流程](#构建与发布流程)
  - [自动更新机制](#自动更新机制)
  - [UI 通知系统](#ui-通知系统)
  - [Preload IPC 桥接](#preload-ipc-桥接)
  - [Daemon 更新策略](#daemon-更新策略)
  - [实施步骤](#实施步骤)
  - [常见问题](#常见问题)

---

# 第一部分：Multica 调研

## 整体架构

Multica 的版本管理分为三层：

| 层级 | 组件 | 版本管理方式 |
|------|------|-------------|
| CLI (Go 二进制) | GoReleaser | git tag → 编译 → GitHub Release |
| Desktop (Electron) | electron-builder + electron-updater | git tag → 打包 → GitHub Release → 自动更新 |
| Web/Backend (Docker) | Docker multi-arch build | git tag → GHCR 镜像 |

**版本源头统一为 `git describe --tags --always --dirty`**，一个 `vX.Y.Z` tag 同时驱动 CLI、Desktop、Docker 三个产物的版本号。

### 端到端流程

```
开发者打 tag (v0.2.0)
  → GitHub Actions 自动构建
  → electron-builder 打包 exe
  → 上传到 GitHub Release（包括 latest.yml）
  → 客户端每小时轮询 latest.yml
  → 发现新版本 → 后台下载
  → 下载完弹通知 → 用户点重启 → 自动安装
```

全程不需要自建服务器，GitHub Release 既是安装包托管，也是版本检查的端点。

---

## 版本号管理

### 版本来源

版本号**唯一来源是 git tag**，通过 `git describe --tags --always --dirty` 获取。

构建时自动转换为 semver 格式：

```
v0.2.0                    → 0.2.0              (正式版本)
v0.1.35-14-gf1415e96      → 0.1.35-14-gf1415e96  (预发布)
f1415e96 (无 tag)          → 0.0.0-f1415e96        (开发回退)
```

**核心函数** (`apps/desktop/scripts/package.mjs`)：

```javascript
/**
 * Pure transformation from `git describe --tags --always --dirty`
 * output to electron-builder's extraMetadata.version.
 *
 *   - empty input              → null   (caller should fall back)
 *   - "v0.1.36"                → "0.1.36"
 *   - "v0.1.35-14-gf1415e96"   → "0.1.35-14-gf1415e96"  (semver prerelease)
 *   - "v0.1.35-…-dirty"        → same, dirty suffix preserved
 *   - "f1415e96" (no tag)      → "0.0.0-f1415e96"        (fallback)
 */
export function normalizeGitVersion(raw) {
  if (!raw) return null;
  const stripped = raw.replace(/^v/, "");
  if (!/^\d/.test(stripped)) {
    // No reachable tag — `git describe` fell back to just the commit hash.
    return `0.0.0-${stripped}`;
  }
  return stripped;
}

function deriveVersion() {
  return normalizeGitVersion(sh("git describe --tags --always --dirty"));
}
```

### 版本注入

打包时通过 electron-builder 的 `-c.extraMetadata.version` 注入：

```bash
electron-builder -c.extraMetadata.version=0.2.0
```

**不修改 `package.json` 源文件**，版本号只在构建时动态注入。

### 运行时获取版本

**源文件**: `apps/desktop/src/main/app-version.ts`

```typescript
import { app } from 'electron';
import { execSync } from 'node:child_process';

/**
 * 打包版本: electron-builder 烘焙的版本 (app.getVersion())
 * 开发版本: git describe --tags --always --dirty
 *   显示如 0.2.19-14-gabcdef-dirty
 *   如果 git 不可用，回退到 app.getVersion()
 */
export function getAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }
  try {
    const raw = execSync("git describe --tags --always --dirty", {
      cwd: app.getAppPath(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!raw) return app.getVersion();
    return raw.replace(/^v/, "");
  } catch {
    return app.getVersion();
  }
}
```

---

## 构建脚本 package.mjs

**源文件**: `apps/desktop/scripts/package.mjs`

构建脚本负责：

1. **构建 Electron 产物** — `electron-vite build`
2. **派生版本号** — `git describe --tags --always --dirty`
3. **打包 Go CLI** — 交叉编译 Go 二进制到 `resources/bin/`
4. **调用 electron-builder** — 传入版本号 `-c.extraMetadata.version`

### 构建流程

```javascript
function main() {
  // Step 1: 构建 Electron main/preload/renderer bundles
  const viteResult = spawnSync("electron-vite", ["build"], {
    stdio: "inherit",
    cwd: desktopRoot,
    shell: true,
  });

  // Step 2: 派生版本号
  const version = deriveVersion();
  // e.g. "0.2.0" from git describe

  // Step 3: 对每个目标平台，打包 CLI 并调用 electron-builder
  for (const target of buildMatrix) {
    // 打包 Go CLI 到 resources/bin/
    execFileSync("node", [bundleCliScript, "--target-platform", ..., "--target-arch", ...]);

    // 调用 electron-builder
    const builderArgs = builderArgsForTarget(target, parsed, version, {
      disableMacNotarize,
      useScopedOutputDir,
    });
    spawnSync("electron-builder", builderArgs, { stdio: "inherit", shell: true });
  }
}
```

### Windows arm64 特殊处理

**问题**：electron-builder 在 Windows 上生成的更新元数据文件始终叫 `latest.yml`，不区分 x64 和 arm64 架构。如果同时构建两个架构，它们都会上传 `latest.yml` 到同一个 GitHub Release，**后上传的会覆盖先上传的**，导致其中一个架构的自动更新失效。

Linux 没有这个问题——electron-builder 会自动给 Linux 的元数据文件加架构后缀（如 `latest-linux-arm64.yml`），但 Windows 不会。

**解决方案**：arm64 使用独立的 update channel，让元数据文件名不同：

```
x64   → latest.yml           (默认 channel)
arm64 → latest-arm64.yml     (自定义 channel)
```

**构建端**（package.mjs）：

```javascript
export function builderArgsForTarget(target, parsed, version, opts = {}) {
  const builderArgs = [];
  if (version) builderArgs.push(`-c.extraMetadata.version=${version}`);
  builderArgs.push(PLATFORM_CONFIG[target.platform].builderFlag);
  // ...
  
  // Windows arm64 使用独立的 update channel
  // 这样 electron-builder 生成 latest-arm64.yml 而不是 latest.yml
  if (target.platform === "win" && target.arch === "arm64") {
    builderArgs.push("-c.publish.channel=latest-arm64");
  }
  return builderArgs;
}
```

**客户端**（updater.ts）：

```typescript
// 客户端也要配置读取对应的 channel
if (process.platform === "win32" && process.arch === "arm64") {
  autoUpdater.channel = "latest-arm64";
}
```

**效果**：

```
GitHub Release v0.2.0:
├── latest.yml              ← Windows x64 的更新元数据
├── latest-arm64.yml        ← Windows arm64 的更新元数据（不会互相覆盖）
├── latest-linux.yml        ← Linux 的更新元数据
└── ...
```

x64 客户端读 `latest.yml`，arm64 客户端读 `latest-arm64.yml`，互不干扰。

**如果 Molio 不需要 arm64 版本**，可以忽略这个问题。只有同时发布 x64 和 arm64 两个架构时才需要处理。

---

## electron-builder 配置

**源文件**: `apps/desktop/electron-builder.yml`

```yaml
appId: ai.multica.desktop
productName: Multica
directories:
  buildResources: build
files:
  - "!**/.vscode/*"
  - "!src/*"
  - "!electron.vite.config.*"
  - "!{.eslintignore,.eslintrc.cjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}"
  - "!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}"
protocols:
  - name: Multica
    schemes:
      - multica
asarUnpack:
  - resources/**

# macOS
mac:
  entitlementsInherit: build/entitlements.mac.plist
  target:
    - dmg
    - zip
  artifactName: multica-desktop-${version}-mac-${arch}.${ext}
  notarize: true
dmg:
  artifactName: multica-desktop-${version}-mac-${arch}.${ext}

# Linux
linux:
  executableName: multica
  desktop:
    entry:
      StartupWMClass: Multica
  icon: build/icons
  target:
    - AppImage
    - deb
    - rpm
  artifactName: multica-desktop-${version}-linux-${arch}.${ext}
rpm:
  fpm:
    - "--rpm-rpmbuild-define=_build_id_links none"

# Windows
win:
  target:
    - nsis
  artifactName: multica-desktop-${version}-windows-${arch}.${ext}

# 发布配置（关键！）
publish:
  provider: github
  owner: multica-ai
  repo: multica
  releaseType: release    # 必须是 release，不能是 draft
npmRebuild: false
```

### 关键配置说明

**`releaseType: release`** — 这是最关键的配置。electron-updater 只能从**已发布的** Release 中读取更新元数据。如果 Release 是 draft 状态，electron-updater 会检测不到更新。

**`artifactName`** — 命名规范：`multica-desktop-${version}-${platform}-${arch}.${ext}`，从文件名就能看出平台、版本和架构。

**`asarUnpack: resources/**`** — Go CLI 二进制不能被压缩进 asar，需要直接放在文件系统中才能执行。

### 产物结构

GitHub Release 页面包含：

```
v0.2.0 Release
├── multica-desktop-0.2.0-windows-x64.exe       (NSIS 安装包)
├── multica-desktop-0.2.0-linux-x64.AppImage     (Linux AppImage)
├── multica-desktop-0.2.0-linux-x64.deb          (Linux deb)
├── multica-desktop-0.2.0-mac-arm64.dmg          (macOS DMG)
├── latest.yml                                    (Windows x64 更新元数据)
├── latest-arm64.yml                              (Windows arm64 更新元数据)
├── latest-linux.yml                              (Linux 更新元数据)
└── latest-mac.yml                                (macOS 更新元数据)
```

`latest.yml` 示例内容：

```yaml
version: 0.2.0
files:
  - url: multica-desktop-0.2.0-windows-x64.exe
    sha512: <base64 hash>
    size: 89234567
path: multica-desktop-0.2.0-windows-x64.exe
sha512: <base64 hash>
releaseDate: '2026-06-01T10:30:00.000Z'
```

electron-updater 解析这个文件来判断是否有新版本、下载什么文件、校验哈希。

---

## 自动更新 updater.ts

**源文件**: `apps/desktop/src/main/updater.ts`

这是自动更新的核心文件，约 140 行代码。

### 完整源码

```typescript
import { autoUpdater, UpdateDownloadedEvent } from "electron-updater";
import { app, BrowserWindow, ipcMain } from "electron";

// ─── 配置 ───────────────────────────────────────────────────

// 静默后台更新：发现新版本后自动下载，下载完成后通知用户
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// Windows arm64 使用独立的 update channel
if (process.platform === "win32" && process.arch === "arm64") {
  autoUpdater.channel = "latest-arm64";
}

const STARTUP_CHECK_DELAY_MS = 5_000;           // 启动后 5 秒检查
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时检查

// ─── 类型定义 ──────────────────────────────────────────────

export type ManualUpdateCheckResult =
  | { ok: true; currentVersion: string; latestVersion: string; available: boolean }
  | { ok: false; error: string };

// ─── 防重复检查 (single-flight guard) ──────────────────────

let inFlightCheck: Promise<unknown> | null = null;

function checkForUpdatesOnce(): Promise<unknown> {
  if (inFlightCheck) return inFlightCheck;
  const p = autoUpdater
    .checkForUpdates()
    .then((result) => {
      // 处理下载失败的 promise，避免 unhandled rejection
      void (result as { downloadPromise?: Promise<unknown> } | null)
        ?.downloadPromise?.catch((err) => {
          console.error("Failed to download update:", err);
        });
      return result;
    })
    .finally(() => {
      if (inFlightCheck === p) inFlightCheck = null;
    });
  inFlightCheck = p;
  return p;
}

// ─── 主函数 ─────────────────────────────────────────────────

export function setupAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  
  // 事件：发现新版本
  autoUpdater.on("update-available", (info) => {
    const win = getMainWindow();
    win?.webContents.send("updater:update-available", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  // 事件：下载进度
  autoUpdater.on("download-progress", (progress) => {
    const win = getMainWindow();
    win?.webContents.send("updater:download-progress", {
      percent: progress.percent,
    });
  });

  // 事件：下载完成
  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    const win = getMainWindow();
    win?.webContents.send("updater:update-downloaded", {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  // 事件：错误
  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err);
  });

  // IPC: 手动下载（保留兼容，autoDownload=true 后不再使用）
  ipcMain.handle("updater:download", () => {
    return autoUpdater.downloadUpdate();
  });

  // IPC: 安装并重启
  ipcMain.handle("updater:install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // IPC: 手动检查更新
  ipcMain.handle("updater:check", async (): Promise<ManualUpdateCheckResult> => {
    try {
      const result = (await checkForUpdatesOnce()) as
        | { updateInfo: { version: string }; isUpdateAvailable?: boolean }
        | null;
      const currentVersion = app.getVersion();
      // 信任 electron-updater 的判断，不自己比较版本号
      // 因为预发布通道、分阶段发布等情况下，版本号不同但不一定有可用更新
      return {
        ok: true,
        currentVersion,
        latestVersion: result?.updateInfo.version ?? currentVersion,
        available: result?.isUpdateAvailable ?? false,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // 启动后延迟检查（不阻塞启动）
  setTimeout(() => {
    checkForUpdatesOnce().catch((err) => {
      console.error("Failed to check for updates:", err);
    });
  }, STARTUP_CHECK_DELAY_MS);

  // 定时轮询（长时间运行的会话也能检测到更新）
  setInterval(() => {
    checkForUpdatesOnce().catch((err) => {
      console.error("Periodic update check failed:", err);
    });
  }, PERIODIC_CHECK_INTERVAL_MS);
}
```

### 设计要点

1. **`autoDownload = true`**：发现新版本后自动后台下载，用户无感知
2. **`autoInstallOnAppQuit = true`**：退出应用时自动安装，用户不需要额外操作
3. **single-flight guard**：防止启动检查、定时轮询、手动检查三个触发源同时发起请求
4. **信任 electron-updater 判断**：手动检查时使用 `isUpdateAvailable` 而不是自己比较版本号，因为预发布通道、分阶段发布等场景下版本号比较不准确
5. **下载 promise 错误处理**：`checkForUpdates` resolve 时下载可能还在进行，需要 catch `downloadPromise` 避免 unhandled rejection

### 更新流程

```
1. 检查更新
   └─ autoUpdater.checkForUpdates()
       └─ 请求 GitHub Release 的 latest.yml
       └─ 对比本地版本 vs yml 中的版本

2. 发现新版本 → 触发 update-available 事件
   └─ autoDownload=true，自动开始后台下载

3. 下载中 → 触发 download-progress 事件
   └─ 传递 percent 给渲染进程

4. 下载完成 → 触发 update-downloaded 事件
   └─ 渲染进程显示通知弹窗

5. 安装更新（两种方式）:
   a. 用户点击 "Restart now" → autoUpdater.quitAndInstall(false, true)
   b. 用户退出应用时自动安装 (autoInstallOnAppQuit)
```

---

## UI 通知组件

**源文件**: `apps/desktop/src/renderer/src/components/update-notification.tsx`

仅在更新**完全下载完毕**后才显示，右下角浮动通知：

```tsx
import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

// 下载过程完全静默，只在下载完成后显示 UI
type UpdateState =
  | { status: "idle" }
  | { status: "ready"; version: string };

export function UpdateNotification() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const cleanup = window.updater.onUpdateDownloaded((info) => {
      setState({ status: "ready", version: info.version });
      setDismissed(false);  // 新版本下载完，重置 dismissed 状态
    });
    return cleanup;
  }, []);

  if (state.status === "idle") return null;
  if (dismissed) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-border bg-background p-4 shadow-lg animate-in slide-in-from-bottom-2 fade-in duration-300">
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="absolute top-2 right-2 rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        <X className="size-3.5" />
      </button>

      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-success/10 p-1.5">
          <RefreshCw className="size-4 text-success" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Update ready</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            v{state.version} will be applied on next launch.
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
            >
              Later
            </button>
            <button
              type="button"
              onClick={() => window.updater.installUpdate()}
              className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Restart now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

### 设计要点

- **只在下载完成后显示**：下载过程完全静默，不打扰用户
- **dismissed 状态**：用户点 Later 或 X 后消失，但新版本下载完会重新显示
- **两个按钮**：Later（稍后）和 Restart now（立即重启）

---

## 设置页更新标签

**源文件**: `apps/desktop/src/renderer/src/components/updates-settings-tab.tsx`

在设置页面提供手动检查入口：

```tsx
import { useCallback, useState } from "react";
import { AlertCircle, ArrowDownToLine, Check, Loader2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "@multica/views/i18n";

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date" }
  | { status: "available"; latestVersion: string }
  | { status: "error"; message: string };

export function UpdatesSettingsTab() {
  const { t } = useT("settings");
  const [state, setState] = useState<CheckState>({ status: "idle" });
  const currentVersion = window.desktopAPI.appInfo.version;

  const handleCheck = useCallback(async () => {
    setState({ status: "checking" });
    const result = await window.updater.checkForUpdates();
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState(
      result.available
        ? { status: "available", latestVersion: result.latestVersion }
        : { status: "up-to-date" }
    );
  }, []);

  return (
    <div>
      <h2 className="text-lg font-semibold">{t(($) => $.desktop.updates.title)}</h2>
      <p className="text-sm text-muted-foreground mt-1">
        {t(($) => $.desktop.updates.description)}
      </p>

      <div className="mt-6 divide-y">
        {/* 当前版本 */}
        <div className="flex items-center justify-between gap-6 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t(($) => $.desktop.updates.current_version)}</p>
            <p className="text-sm text-muted-foreground mt-0.5 font-mono">
              v{currentVersion}
            </p>
          </div>
        </div>

        {/* 手动检查 */}
        <div className="flex items-start justify-between gap-6 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t(($) => $.desktop.updates.check_section_title)}</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t(($) => $.desktop.updates.check_section_description)}
            </p>
            {state.status === "up-to-date" && (
              <p className="text-sm text-muted-foreground mt-2 inline-flex items-center gap-1.5">
                <Check className="size-3.5 text-success" />
                {t(($) => $.desktop.updates.up_to_date)}
              </p>
            )}
            {state.status === "available" && (
              <p className="text-sm text-muted-foreground mt-2 inline-flex items-center gap-1.5">
                <ArrowDownToLine className="size-3.5 text-primary" />
                {t(($) => $.desktop.updates.downloading, { version: state.latestVersion })}
              </p>
            )}
            {state.status === "error" && (
              <p className="text-sm text-destructive mt-2 inline-flex items-center gap-1.5">
                <AlertCircle className="size-3.5" />
                {state.message}
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Button variant="outline" size="sm" onClick={handleCheck} disabled={state.status === "checking"}>
              {state.status === "checking" ? (
                <><Loader2 className="size-3.5 animate-spin" />{t(($) => $.desktop.updates.checking)}</>
              ) : (
                t(($) => $.desktop.updates.check_now)
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

### 国际化文案

**源文件**: `packages/views/locales/en/settings.json`

```json
{
  "desktop": {
    "updates": {
      "title": "Updates",
      "description": "The desktop app checks for new versions automatically...",
      "current_version": "Current version",
      "check_section_title": "Check for updates",
      "check_section_description": "Trigger a check now instead of waiting...",
      "up_to_date": "You're on the latest version.",
      "downloading": "v{{version}} is downloading in the background...",
      "check_now": "Check now",
      "checking": "Checking..."
    }
  }
}
```

---

## Preload IPC 桥接

**源文件**: `apps/desktop/src/preload/index.ts`

暴露给渲染进程的 updater API：

```typescript
const updaterAPI = {
  // 监听事件
  onUpdateAvailable: (callback: (info: { version: string; releaseNotes?: string }) => void) => {
    const handler = (_: unknown, info: { version: string; releaseNotes?: string }) => callback(info);
    ipcRenderer.on("updater:update-available", handler);
    return () => ipcRenderer.removeListener("updater:update-available", handler);
  },
  onDownloadProgress: (callback: (progress: { percent: number }) => void) => {
    const handler = (_: unknown, progress: { percent: number }) => callback(progress);
    ipcRenderer.on("updater:download-progress", handler);
    return () => ipcRenderer.removeListener("updater:download-progress", handler);
  },
  onUpdateDownloaded: (callback: (info: { version: string; releaseNotes?: string }) => void) => {
    const handler = (_: unknown, info: { version: string; releaseNotes?: string }) => callback(info);
    ipcRenderer.on("updater:update-downloaded", handler);
    return () => ipcRenderer.removeListener("updater:update-downloaded", handler);
  },

  // 操作
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  checkForUpdates: (): Promise<ManualUpdateCheckResult> => ipcRenderer.invoke("updater:check"),
};

// 暴露到 window 对象
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("updater", updaterAPI);
} else {
  window.updater = updaterAPI;
}
```

渲染进程使用方式：

```typescript
// 监听更新下载完成
window.updater.onUpdateDownloaded((info) => {
  console.log(`v${info.version} 下载完成`);
});

// 手动检查更新
const result = await window.updater.checkForUpdates();
if (result.ok && result.available) {
  console.log(`有更新: ${result.latestVersion}`);
}

// 安装并重启
window.updater.installUpdate();
```

---

## Daemon 版本协调

**源文件**: `apps/desktop/src/main/version-decision.ts`

### 背景

Multica Desktop 内嵌了 Go CLI 二进制（打包在 `resources/bin/` 里）。当 Electron 通过 auto-updater 更新后，新版本的 Electron 内嵌了新版 CLI，但旧的 daemon 进程可能还在运行——它用的是旧版代码（已经在内存里了）。

这就产生了一个问题：**新 Electron 里的 CLI 版本 vs 正在运行的 daemon 版本不一致，要不要重启 daemon？**

### 触发场景

```
用户安装了 v0.1.0
  → Electron 启动 → spawn daemon (v0.1.0)
  → 用户正常使用...

后台自动更新到 v0.2.0
  → 用户点"重启"
  → Electron 重启（现在是 v0.2.0，内嵌的 CLI 也是 v0.2.0）
  → 但 daemon 可能还没重启（或者在更新过程中 daemon 没被正确关闭）

此时：bundled CLI = v0.2.0, running daemon = v0.1.0 → 版本不一致
```

### 决策逻辑

```typescript
export interface VersionCheckHealth {
  status?: string;
  cli_version?: string;      // daemon 报告的版本（通过 /health 接口）
  active_task_count?: number; // 当前正在执行的 agent 任务数
}

export type VersionAction = "restart" | "defer" | "ok" | "not_running";

export function decideVersionAction(
  bundled: string | null,    // Electron 内嵌的 CLI 版本
  running: VersionCheckHealth | null,  // daemon /health 接口返回的状态
): VersionAction {
  // 1. daemon 没在运行 → 不需要处理（Electron 启动时会自己 spawn）
  if (!running || running.status !== "running") return "not_running";

  const runningVersion = running.cli_version;
  // 2. 任一版本未知 → 返回 ok（fail safe，不冒险重启）
  if (!bundled || !runningVersion) return "ok";
  // 3. 版本一致 → 不需要处理
  if (runningVersion === bundled) return "ok";

  // 版本不一致，需要重启 daemon 来加载新版本
  const activeTasks = running.active_task_count ?? 0;
  // 4. 有活跃任务 → defer（等任务完成后再重启，不中断用户工作）
  if (activeTasks > 0) return "defer";
  // 5. 没有活跃任务 → 立即重启
  return "restart";
}
```

### 四种返回值

| 返回值 | 含义 | 后续动作 |
|--------|------|---------|
| `not_running` | daemon 没启动 | Electron 启动时自动 spawn daemon |
| `ok` | 版本一致或未知 | 无需操作 |
| `defer` | 版本不一致但有任务在跑 | 等任务排空后再检查（定时轮询） |
| `restart` | 版本不一致且空闲 | kill daemon → 用新 CLI 重新 spawn |

### 设计要点

- **纯函数**：无 I/O、无副作用，方便单元测试
- **fail safe**：版本未知时返回 `ok`，不冒险重启
- **defer 机制**：有活跃 agent 任务时不重启，等任务完成后再处理
- **保护用户体验**：不会因为版本不一致而中断正在进行的 agent 对话

### 对 Molio 的参考

Molio 的 daemon 是 Node.js 应用，打包在 `resources/daemon/` 里。更新后也会面临同样的问题——新 Electron 里是新版 daemon 代码，但旧 daemon 进程还在内存里跑。

Molio 可以采用更简单的策略：**Electron 重启时直接 kill 旧 daemon 再 spawn 新的**，因为 Molio 的 daemon 是无状态的 HTTP 服务（状态在 SQLite 里），重启不会丢失数据。如果 Molio 未来也有长时间运行的 agent 任务，再引入 defer 机制。

---

## 客户端身份标识

**源文件**: `packages/core/api/client.ts`

Desktop 应用通过 HTTP headers 向服务器报告自身版本和平台信息：

```typescript
if (id?.version) headers["X-Client-Version"] = id.version;
if (id?.platform) headers["X-Client-Platform"] = id.platform;
if (id?.os) headers["X-Client-OS"] = id.os;
```

这些信息在 preload 中同步获取（零 IPC 开销）：

```typescript
// preload/index.ts
function fetchAppInfo(): { version: string; os: "macos" | "windows" | "linux" | "unknown" } {
  try {
    const info = ipcRenderer.sendSync("app:get-info") as ...;
    if (info && typeof info.version === "string" && typeof info.os === "string") return info;
  } catch { /* fall through */ }
  const p = process.platform;
  const os = p === "darwin" ? "macos" : p === "win32" ? "windows" : p === "linux" ? "linux" : "unknown";
  return { version: "unknown", os };
}
```

---

## GitHub Actions 发布流程

**源文件**: `.github/workflows/release.yml`

### 触发条件

```yaml
on:
  push:
    tags:
      - "v*.*.*"
      - "!v*-dirty*"    # 排除 dirty tag
```

### 工作流程

```
git tag v0.2.0 && git push origin v0.2.0
    │
    ├─ verify: 验证 tag 格式 (必须 vX.Y.Z 或 vX.Y.Z-suffix) + Go 测试
    │
    ├─ release: GoReleaser 编译 CLI 二进制 → GitHub Release
    │
    ├─ docker-backend-build/merge: 多架构 Docker 镜像 → GHCR
    │   ├─ amd64 on ubuntu-latest
    │   └─ arm64 on ubuntu-24.04-arm (原生构建，不用 QEMU)
    │
    ├─ docker-web-build/merge: 多架构 Web 镜像 → GHCR
    │
    ├─ helm-chart: Helm chart → GHCR OCI
    │
    └─ desktop: electron-builder 打包
        ├─ Linux (ubuntu-latest): AppImage + deb + rpm
        └─ Windows (windows-latest): NSIS
        → 上传到 GitHub Release
        (macOS 手动签名，需要 Apple Developer ID，不在 CI 中)
```

### Desktop 构建 Job

```yaml
desktop:
  needs: release    # 等 Go CLI 发布完成后再打包
  strategy:
    fail-fast: false
    matrix:
      include:
        - os: ubuntu-latest
          target: linux
        - os: windows-latest
          target: win
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0    # 需要完整 git 历史用于 git describe
    
    - name: Install rpmbuild (Linux)
      if: matrix.target == 'linux'
      run: sudo apt-get update && sudo apt-get install -y rpm
    
    - uses: actions/setup-go@v5
      with:
        go-version-file: server/go.mod
    
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: pnpm
    
    - name: Install dependencies
      run: pnpm install --frozen-lockfile
    
    - name: Package Desktop installers
      working-directory: apps/desktop
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        CSC_IDENTITY_AUTO_DISCOVERY: "false"    # 暂时不签名
      run: node scripts/package.mjs --${{ matrix.target }} --x64 --arm64 --publish always
```

### 关键说明

- **`fetch-depth: 0`**：需要完整 git 历史，否则 `git describe` 找不到 tag
- **`--publish always`**：强制上传到 GitHub Release，即使 electron-builder 认为不需要
- **`CSC_IDENTITY_AUTO_DISCOVERY: "false"`**：禁用代码签名自动发现，Linux/Windows 暂不签名
- **`needs: release`**：Desktop 构建依赖 CLI 发布，确保打包的 CLI 是最新版本

---

## 关键文件索引

| 文件 | 作用 |
|------|------|
| `apps/desktop/src/main/updater.ts` | 自动更新核心逻辑 (~140 行) |
| `apps/desktop/src/main/app-version.ts` | 运行时版本获取 |
| `apps/desktop/src/main/version-decision.ts` | Daemon 版本协调决策 |
| `apps/desktop/src/renderer/src/components/update-notification.tsx` | 更新就绪通知 UI (~65 行) |
| `apps/desktop/src/renderer/src/components/updates-settings-tab.tsx` | 设置页更新标签 (~95 行) |
| `apps/desktop/src/preload/index.ts` | Preload IPC 桥接 |
| `apps/desktop/electron-builder.yml` | electron-builder 配置 |
| `apps/desktop/scripts/package.mjs` | 构建脚本 (版本注入 + 多平台打包) |
| `.github/workflows/release.yml` | GitHub Actions 发布工作流 |
| `packages/core/api/client.ts` | 客户端身份标识 headers |
| `packages/views/locales/en/settings.json` | 更新相关国际化文案 |

---

# 第二部分：Molio 实施方案

## Molio 架构特点

Molio 是一个 pnpm monorepo 项目，与 Multica 有以下关键区别：

| 对比项 | Multica | Molio |
|--------|---------|-----|
| Daemon 语言 | Go 二进制 | Node.js (Hono HTTP server) |
| Daemon 功能 | CLI + 后台服务 | 纯 HTTP 服务 (port 3100) |
| UI 框架 | Next.js | Vite + React |
| 构建复杂度 | GoReleaser + Docker + Helm + electron-builder | 仅 electron-builder |
| 多架构 | x64 + arm64 | 仅 x64（当前） |
| Daemon 子进程 | Go CLI 二进制 | 外部 agent CLI（Claude Code, Codex 等） |

Molio 的 Electron 壳需要做的事情：

1. **启动 daemon** — spawn Node.js 进程运行 `apps/daemon` 的代码
2. **加载 Web UI** — 加载 `apps/web` 构建产物（或 dev server）
3. **管理生命周期** — daemon 随 Electron 启停

---

## 方案选型

Molio 采用 **electron-updater + GitHub Release** 方案，与 Multica 一致。

- **版本管理**：git tag 驱动
- **更新分发**：GitHub Release（免费、无需自建服务器）
- **自动更新**：electron-updater（静默后台下载 + 用户确认安装）
- **Daemon 更新**：打包进 Electron resources，随主程序一起更新（方案 A）
- **暂不需要**：arm64 支持、Docker 部署、Helm chart

---

## 版本号管理

### 版本来源

版本号唯一来源是 git tag：

```bash
git tag v0.2.0
git push origin v0.2.0
```

构建时自动转换为 semver 格式：

```
v0.2.0                    → 0.2.0              (正式版本)
v0.1.35-14-gf1415e96      → 0.1.35-14-gf1415e96  (预发布)
f1415e96 (无 tag)          → 0.0.0-f1415e96        (开发回退)
```

### 版本注入

打包时通过 electron-builder 的命令行参数 `-c.extraMetadata.version` 注入：

```bash
# 构建脚本自动执行，版本号 "0.2.0" 来自 git describe --tags
electron-builder -c.extraMetadata.version=0.2.0 --win --x64
```

**`-c.extraMetadata.version=0.2.0`** 告诉 electron-builder 在打包时使用 `0.2.0` 作为版本号，**覆盖** package.json 中的 version 字段。只在构建时生效，不修改源文件。

`apps/desktop/package.json` 中的 version 保持为固定值（如 `"0.0.0"`），因为打包时总是通过命令行参数传入真实版本号。

**版本号传递链**：

```
git tag v0.2.0
  → git describe --tags → "v0.2.0"
  → normalizeGitVersion() → "0.2.0"
  → 构建脚本传给 electron-builder: -c.extraMetadata.version=0.2.0
  → electron-builder 写入打包后的 package.json
  → app.getVersion() 返回 "0.2.0"
```

### normalizeGitVersion 函数

```typescript
// apps/desktop/scripts/package.mjs

function normalizeGitVersion(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/^v/, '');
  if (!/^\d/.test(stripped)) {
    // 没有可达的 tag，git describe 只返回了 commit hash
    return `0.0.0-${stripped}`;
  }
  return stripped;
}

function deriveVersion(): string | null {
  const raw = execSync('git describe --tags --always --dirty', {
    encoding: 'utf-8',
  }).trim();
  return normalizeGitVersion(raw);
}
```

### 运行时获取版本

```typescript
// apps/desktop/src/main/app-version.ts
import { app } from 'electron';
import { execSync } from 'node:child_process';

export function getAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();  // 打包版本：electron-builder 注入的版本
  }
  // 开发环境：回退到 git describe，显示如 "0.2.19-14-gabcdef-dirty"
  try {
    const raw = execSync('git describe --tags --always --dirty', {
      cwd: app.getAppPath(),  // 确保在正确的目录执行
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw.replace(/^v/, '');
  } catch {
    return app.getVersion();
  }
}
```

**注意**：`cwd` 使用 `app.getAppPath()` 而不是 `process.cwd()`。在 pnpm monorepo 中，`process.cwd()` 可能指向 monorepo 根目录，而 `app.getAppPath()` 始终返回 Electron 应用的根目录。

---

## 构建流程

### Molio 的构建步骤

Molio 不像 Multica 那样需要编译 Go 二进制，构建流程更简单：

```
1. pnpm build:daemon   → 编译 daemon 到 apps/daemon/dist/
2. pnpm build:web      → 编译 Web UI 到 apps/web/dist/
3. electron-vite build → 编译 Electron 主进程 + preload
4. electron-builder    → 打包成 NSIS 安装包，注入版本号
```

### 构建脚本

```javascript
// apps/desktop/scripts/package.mjs
import { execSync, spawnSync } from 'node:child_process';

function normalizeGitVersion(raw) {
  if (!raw) return null;
  const stripped = raw.replace(/^v/, '');
  if (!/^\d/.test(stripped)) return `0.0.0-${stripped}`;
  return stripped;
}

function deriveVersion() {
  const raw = execSync('git describe --tags --always --dirty', {
    encoding: 'utf-8',
  }).trim();
  return normalizeGitVersion(raw);
}

function main() {
  // Step 1: 构建 Electron 主进程和 preload
  const viteResult = spawnSync('electron-vite', ['build'], {
    stdio: 'inherit',
    shell: true,  // Windows 上需要 shell: true 来执行 .cmd 文件
  });
  if (viteResult.status !== 0) process.exit(viteResult.status ?? 1);

  // Step 2: 派生版本号
  const version = deriveVersion();
  console.log(`[package] version → ${version}`);

  // Step 3: 调用 electron-builder
  const builderArgs = [];
  if (version) builderArgs.push(`-c.extraMetadata.version=${version}`);
  builderArgs.push('--win', '--x64');

  const result = spawnSync('electron-builder', builderArgs, {
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

main();
```

### electron-builder 配置

```yaml
# apps/desktop/electron-builder.yml
appId: com.molio.desktop
productName: Molio

directories:
  buildResources: build

files:
  - "!**/.vscode/*"
  - "!src/*"

# 打包 daemon 编译产物到 resources 目录
# Electron 启动时 spawn 这个 daemon 进程
extraResources:
  - from: ../daemon/dist
    to: daemon
    filter:
      - "**/*"

# 打包 Web UI 编译产物到 resources 目录
# Electron 的 BrowserWindow 加载这个目录的 HTML
  - from: ../web/dist
    to: web
    filter:
      - "**/*"

# Windows 配置
win:
  target:
    - nsis
  artifactName: molio-desktop-${version}-windows-${arch}.${ext}

# 发布到 GitHub Release
publish:
  provider: github
  owner: your-github-username      # 改成你的 GitHub 用户名
  repo: knowledge-growth-engine    # 改成你的仓库名
  releaseType: release             # 必须是 release，不能是 draft
```

### 安装后的目录结构

```
C:\Users\xxx\AppData\Local\Molio\
├── Molio.exe                          ← Electron 主程序
├── resources/
│   ├── app.asar                     ← Electron 主进程 + preload 代码
│   ├── daemon/                      ← daemon 编译产物
│   │   ├── index.js                 ← daemon 入口
│   │   └── ...
│   └── web/                         ← Web UI 编译产物
│       ├── index.html
│       └── assets/
└── ...
```

### 产物结构

GitHub Release 页面包含：

```
v0.2.0 Release
├── molio-desktop-0.2.0-windows-x64.exe    (NSIS 安装包)
├── latest.yml                            (更新元数据)
└── RELEASE_NOTES.md                      (更新日志)
```

`latest.yml` 由 electron-builder 自动生成，内容示例：

```yaml
version: 0.2.0
files:
  - url: molio-desktop-0.2.0-windows-x64.exe
    sha512: <base64 hash>
    size: 89234567
path: molio-desktop-0.2.0-windows-x64.exe
sha512: <base64 hash>
releaseDate: '2026-06-01T10:30:00.000Z'
```

---

## Electron 主进程

### 启动 daemon 和加载 UI

```typescript
// apps/desktop/src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { setupAutoUpdater } from './updater';
import { getAppVersion } from './app-version';

let mainWindow: BrowserWindow | null = null;
let daemonProcess: ChildProcess | null = null;

function startDaemon(): void {
  const daemonEntry = path.join(process.resourcesPath, 'daemon', 'index.js');
  daemonProcess = spawn(process.execPath, [daemonEntry], {
    env: { ...process.env, PORT: '3100', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemonProcess.stdout?.on('data', (d) => console.log(`[daemon] ${d}`));
  daemonProcess.stderr?.on('data', (d) => console.error(`[daemon] ${d}`));
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    // 生产环境：加载打包后的 Web UI
    const webIndex = path.join(process.resourcesPath, 'web', 'index.html');
    mainWindow.loadFile(webIndex);
  } else {
    // 开发环境：连接 Vite dev server
    mainWindow.loadURL('http://localhost:5173');
  }
}

app.whenReady().then(() => {
  startDaemon();
  createMainWindow();
  setupAutoUpdater(() => mainWindow);
});

app.on('before-quit', () => {
  daemonProcess?.kill();
});

app.on('window-all-closed', () => {
  app.quit();
});
```

### app-info IPC

供 preload 同步获取应用版本和平台信息：

```typescript
// 在 main/index.ts 中添加
import { ipcMain } from 'electron';

ipcMain.on('app:get-info', (event) => {
  const platform = process.platform;
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  event.returnValue = {
    version: getAppVersion(),
    os,
  };
});
```

---

## 自动更新

### updater.ts

```typescript
// apps/desktop/src/main/updater.ts
import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, ipcMain } from 'electron';

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const STARTUP_CHECK_DELAY_MS = 5_000;
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let inFlightCheck: Promise<unknown> | null = null;

function checkForUpdatesOnce(): Promise<unknown> {
  if (inFlightCheck) return inFlightCheck;
  const p = autoUpdater.checkForUpdates()
    .then((result) => {
      void (result as { downloadPromise?: Promise<unknown> } | null)
        ?.downloadPromise?.catch((err) => console.error('Download failed:', err));
      return result;
    })
    .finally(() => {
      if (inFlightCheck === p) inFlightCheck = null;
    });
  inFlightCheck = p;
  return p;
}

export function setupAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  autoUpdater.on('update-available', (info) => {
    getMainWindow()?.webContents.send('updater:update-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    getMainWindow()?.webContents.send('updater:download-progress', { percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    getMainWindow()?.webContents.send('updater:update-downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
  });

  ipcMain.handle('updater:check', async () => {
    try {
      const result = await checkForUpdatesOnce() as
        | { updateInfo: { version: string }; isUpdateAvailable?: boolean } | null;
      const currentVersion = app.getVersion();
      return {
        ok: true as const,
        currentVersion,
        latestVersion: result?.updateInfo.version ?? currentVersion,
        available: result?.isUpdateAvailable ?? false,
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  setTimeout(() => { checkForUpdatesOnce().catch(console.error); }, STARTUP_CHECK_DELAY_MS);
  setInterval(() => { checkForUpdatesOnce().catch(console.error); }, PERIODIC_CHECK_INTERVAL_MS);
}
```

### 更新流程

```
1. electron-updater 请求 GitHub Release 的 latest.yml（每小时 + 启动后 5 秒）
2. 对比版本：本地 0.1.0 < 远程 0.2.0 → 有更新
3. autoDownload=true → 后台下载 .exe 安装包（用户无感知）
4. 下载完成 → update-downloaded 事件 → UI 弹出通知
5. 用户选择：
   a. "立即重启" → quitAndInstall() → NSIS 覆盖安装 → 重启
   b. "稍后" → 通知消失，下次检查时再提示
   c. 退出应用 → autoInstallOnAppQuit → 自动安装
```

### NSIS 覆盖安装

更新时 NSIS 会覆盖整个安装目录：

```
C:\Users\xxx\AppData\Local\Molio\
├── Molio.exe                    ← 新的 Electron
├── resources/
│   ├── app.asar               ← 新的主进程代码
│   ├── daemon/                ← 新的 daemon（自动更新）
│   └── web/                   ← 新的 Web UI（自动更新）
└── ...
```

**安装包就是更新包**，原地覆盖，不会出现两个 exe 并存。

---

## UI 组件

### 更新就绪通知

仅在下载完成后显示，右下角浮动通知：

```tsx
// apps/web/src/components/UpdateNotification.tsx
import { useEffect, useState } from 'react';

type UpdateState = { status: 'idle' } | { status: 'ready'; version: string };

export function UpdateNotification() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.updater) return;
    const cleanup = window.updater.onUpdateDownloaded((info) => {
      setState({ status: 'ready', version: info.version });
      setDismissed(false);
    });
    return cleanup;
  }, []);

  if (state.status === 'idle' || dismissed) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border bg-background p-4 shadow-lg">
      <button onClick={() => setDismissed(true)} className="absolute top-2 right-2 text-sm">✕</button>
      <p className="text-sm font-medium">更新就绪</p>
      <p className="text-xs text-muted-foreground mt-1">v{state.version} 将在重启后应用</p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => setDismissed(true)} className="btn btn-outline btn-sm">稍后</button>
        <button onClick={() => window.updater?.installUpdate()} className="btn btn-primary btn-sm">
          立即重启
        </button>
      </div>
    </div>
  );
}
```

### 设置页更新标签

```tsx
// apps/web/src/components/UpdatesSettings.tsx
import { useCallback, useState } from 'react';

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date' }
  | { status: 'available'; latestVersion: string }
  | { status: 'error'; message: string };

export function UpdatesSettings() {
  const [state, setState] = useState<CheckState>({ status: 'idle' });
  const currentVersion = window.desktopAPI?.appInfo.version ?? 'dev';

  const handleCheck = useCallback(async () => {
    if (!window.updater) return;
    setState({ status: 'checking' });
    const result = await window.updater.checkForUpdates();
    if (!result.ok) {
      setState({ status: 'error', message: result.error });
      return;
    }
    setState(
      result.available
        ? { status: 'available', latestVersion: result.latestVersion }
        : { status: 'up-to-date' }
    );
  }, []);

  return (
    <div>
      <h2 className="text-lg font-semibold">更新</h2>
      <p className="text-sm text-muted-foreground mt-1">应用会自动检查并下载新版本</p>
      <div className="mt-6 divide-y">
        <div className="py-4">
          <p className="text-sm font-medium">当前版本</p>
          <p className="text-sm text-muted-foreground mt-1 font-mono">v{currentVersion}</p>
        </div>
        <div className="py-4">
          <p className="text-sm font-medium">检查更新</p>
          {state.status === 'up-to-date' && <p className="text-sm mt-2">✓ 已是最新版本</p>}
          {state.status === 'available' && <p className="text-sm mt-2">↓ v{state.latestVersion} 正在后台下载</p>}
          {state.status === 'error' && <p className="text-sm text-red-500 mt-2">✕ {state.message}</p>}
          <button onClick={handleCheck} disabled={state.status === 'checking'} className="btn btn-outline btn-sm mt-3">
            {state.status === 'checking' ? '检查中...' : '立即检查'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## Preload IPC 桥接

```typescript
// apps/desktop/src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

// 同步获取应用信息（零 IPC 开销，preload 时执行）
function fetchAppInfo() {
  try {
    return ipcRenderer.sendSync('app:get-info') as { version: string; os: string };
  } catch {
    return { version: 'unknown', os: 'unknown' };
  }
}

const desktopAPI = {
  appInfo: fetchAppInfo(),
};

const updaterAPI = {
  onUpdateAvailable: (cb: (info: { version: string }) => void) => {
    const handler = (_: unknown, info: { version: string }) => cb(info);
    ipcRenderer.on('updater:update-available', handler);
    return () => ipcRenderer.removeListener('updater:update-available', handler);
  },
  onDownloadProgress: (cb: (p: { percent: number }) => void) => {
    const handler = (_: unknown, p: { percent: number }) => cb(p);
    ipcRenderer.on('updater:download-progress', handler);
    return () => ipcRenderer.removeListener('updater:download-progress', handler);
  },
  onUpdateDownloaded: (cb: (info: { version: string }) => void) => {
    const handler = (_: unknown, info: { version: string }) => cb(info);
    ipcRenderer.on('updater:update-downloaded', handler);
    return () => ipcRenderer.removeListener('updater:update-downloaded', handler);
  },
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check') as Promise<
    | { ok: true; currentVersion: string; latestVersion: string; available: boolean }
    | { ok: false; error: string }
  >,
};

contextBridge.exposeInMainWorld('desktopAPI', desktopAPI);
contextBridge.exposeInMainWorld('updater', updaterAPI);
```

---

## GitHub Actions 发布流程

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
    runs-on: windows-latest    # Molio 当前只发布 Windows 版本
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0       # 需要完整 git 历史用于 git describe

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build daemon
        run: pnpm build:daemon

      - name: Build web UI
        run: pnpm build:web

      - name: Package Desktop
        working-directory: apps/desktop
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
        run: node scripts/package.mjs

      # electron-builder 自动上传到 GitHub Release
```

### 发布步骤

```bash
# 1. 确保代码已合并到主分支
git checkout main && git pull

# 2. 打 tag
git tag v0.1.0
git push origin v0.1.0

# 3. GitHub Actions 自动：
#    → 构建 daemon + web UI
#    → electron-vite build (Electron 主进程)
#    → electron-builder 打包 (NSIS .exe)
#    → 上传到 GitHub Release (包括 latest.yml)

# 4. 用户安装 v0.1.0

# 5. 下次发版时打新 tag
git tag v0.2.0
git push origin v0.2.0

# 6. 用户启动 v0.1.0 → electron-updater 检测到 v0.2.0 → 自动下载 → 提示重启
```

---

## Daemon 独立更新（备选方案）

如果未来 daemon 迭代频繁，需要独立于 Electron 更新，可以切换到 npm 包方式。

### 方案对比

| | 打包进 Electron (当前) | npm 包独立更新 (备选) |
|---|---|---|
| 更新粒度 | UI + daemon 一起 | 可以只更新 daemon |
| 更新包大小 | 大（整个安装包） | 小（只有 daemon） |
| 实现复杂度 | 低 | 高 |
| 用户体验 | 一次更新全搞定 | 需要额外步骤 |
| 版本一致性 | ✅ 始终一致 | ⚠️ 可能不一致 |
| 适用阶段 | 产品初期 | daemon 快速迭代期 |

### npm 方式的核心实现

```typescript
// apps/desktop/src/main/daemon-updater.ts
import { execSync } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

const daemonDir = path.join(app.getPath('userData'), 'daemon');

function checkDaemonUpdate(): boolean {
  try {
    const latest = execSync('npm view @molio/daemon version', { encoding: 'utf-8' }).trim();
    const current = require(
      path.join(daemonDir, 'node_modules/@molio/daemon/package.json')
    ).version;
    return latest !== current;
  } catch { return false; }
}

async function updateDaemon(): Promise<void> {
  // 不需要先停 daemon，运行中的进程用的是内存里的代码
  execSync('npm install @molio/daemon@latest', { cwd: daemonDir, encoding: 'utf-8' });
  // 重启 daemon 子进程加载新代码
  restartDaemon();
}
```

两种方案不冲突，可以平滑过渡。

---

## 实施步骤

### 第一步：安装依赖

```bash
cd apps/desktop
pnpm add electron-updater
pnpm add -D electron-builder
```

### 第二步：创建配置文件

- `apps/desktop/electron-builder.yml` — electron-builder 配置
- `apps/desktop/scripts/package.mjs` — 构建脚本（版本注入）

### 第三步：实现 Electron 主进程

- `apps/desktop/src/main/index.ts` — 启动 daemon + 加载 UI
- `apps/desktop/src/main/updater.ts` — 自动更新逻辑
- `apps/desktop/src/main/app-version.ts` — 运行时版本获取

### 第四步：实现 Preload

- `apps/desktop/src/preload/index.ts` — IPC 桥接

### 第五步：实现 UI 组件

- `apps/web/src/components/UpdateNotification.tsx` — 更新通知
- `apps/web/src/components/UpdatesSettings.tsx` — 设置页更新标签

### 第六步：配置 GitHub Actions

- `.github/workflows/release.yml` — 发布工作流

### 第七步：测试

```bash
# 1. 打 tag v0.1.0，等 CI 构建完成
# 2. 下载安装 v0.1.0
# 3. 打 tag v0.2.0，等 CI 构建完成
# 4. 启动 v0.1.0，验证自动更新流程
```

### 关键文件清单

```
apps/desktop/
├── electron-builder.yml              # electron-builder 配置
├── scripts/
│   └── package.mjs                   # 构建脚本（版本注入）
├── src/
│   ├── main/
│   │   ├── index.ts                  # 主进程入口（启动 daemon + 加载 UI）
│   │   ├── updater.ts                # 自动更新逻辑
│   │   └── app-version.ts            # 运行时版本获取
│   └── preload/
│       └── index.ts                  # IPC 桥接

apps/web/src/components/
├── UpdateNotification.tsx            # 更新就绪通知
└── UpdatesSettings.tsx               # 设置页更新标签

.github/workflows/
└── release.yml                       # GitHub Actions 发布工作流
```

---

## 常见问题

### Q: electron-updater 从哪里检查更新？

A: 从 GitHub Release 的 `latest.yml` 文件。这是一个静态文件（几十 KB），请求非常轻量。客户端每小时轮询一次，加上启动后 5 秒检查一次。

### Q: 私有仓库能用吗？

A: 可以。需要在客户端配置 `GH_TOKEN` 环境变量来访问私有 Release。公开仓库不需要 token。

### Q: Windows 需要代码签名吗？

A: 不强制，但未签名的安装包会触发 Windows SmartScreen 警告。建议正式发版时配置代码签名。

### Q: macOS 怎么处理？

A: macOS 需要 Apple Developer ID 签名和公证（notarization），流程比 Windows/Linux 复杂。Molio 当前只发布 Windows 版本，后续需要时再添加 macOS 支持。

### Q: 更新失败会怎样？

A: electron-updater 会触发 `error` 事件，UI 可以显示错误信息。用户下次启动应用时会重新检查更新。

### Q: daemon 更新时会中断用户操作吗？

A: 打包进 Electron 的方案需要重启应用。但 Molio 的 daemon 是无状态 HTTP 服务（状态在 SQLite 里），重启很快（几百毫秒），SSE 连接会自动重连。

### Q: 能否回退到旧版本？

A: 需要手动下载安装旧版本覆盖安装。electron-updater 不支持自动回退。

### Q: 版本号一定要用 git tag 吗？

A: 不一定，但 git tag 是最简单的方式——不需要手动改任何 version 文件，打什么 tag 就是什么版本。

---

## 参考资源

- [electron-updater 文档](https://www.electron.build/auto-update)
- [electron-builder 文档](https://www.electron.build/)
- [GitHub Release 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- Multica 项目源码：`D:/work/02-code/multica/apps/desktop/`（完整实现参考）
