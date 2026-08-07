# 多窗口支持（Multi-Window）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Molio 支持客户端多开窗口——每个窗口独立绑定一个 vault（URL `?vault=` 驱动），Electron 壳单进程内多 BrowserWindow，daemon 零改动。

**Architecture:** 三层改造：(1) Electron 壳把单 `mainWindow` 泛化为 `appWindows` 集合，保留单实例锁（防第二个进程起 daemon 撞 3100 端口），每窗口独立 per-webContents 的 renderer 就绪状态；(2) Web 端 vault 改由 URL query 参数驱动（`?vault=` 是窗口级权威），localStorage 降级为无 URL 参数的新窗口默认值，URL 与 store 双向同步但 URL 不清除；(3) KB tabs 按 vault 分片（`createTabsStore(vaultId)` 工厂，存储键 `molio.kb.tabs.<vaultId>`），`useKbChat` 会话在 vault 切换时重置。

**Tech Stack:** Electron 40（main process ESM）、React 19 + Vite 6、Hono daemon（不变）、Playwright E2E、node:test（桌面端源码断言）。

## Global Constraints

- 一窗一 vault；新窗口入口 = 菜单「文件→新窗口」⌘N/Ctrl+N + KB 标签右键「在新窗口打开」；**不加 NavRail 按钮**
- daemon **零改动**；`active_vault` 保持「最后激活窗口的 vault」既有语义
- **保留** `requestSingleInstanceLock()`（防第二个进程再起 daemon 撞端口）；多窗口 = 单进程多 BrowserWindow
- WebUI-first：Web 层只产出目标 URL（如 `/knowledge?vault=X&file=Y`），由薄适配层决定「Electron 开窗」或「浏览器 window.open」
- URL `?vault=` 不被清除；`?file=` 保持瞬时（外部导航，处理完即从 URL 移除、状态由 `pendingUrlNav` 持有）
- 每个 BrowserWindow 是独立 renderer（模块级变量天然隔离）；真正跨窗口共享的只有 localStorage + daemon 键，需按 vault 分片
- E2E 前置：`pnpm dev`（daemon :3100 + web :5173）运行中；`pnpm dev` 为根目录命令
- 错误驱动测试：实施中每遇报错，按 `apps/daemon/test`、`apps/desktop/test`、`apps/web/e2e` 对应位置补测试
- P1（PR #202 `createTabsStore`）若在本计划执行期间合并，则做同形对齐（Task 8）；未合并则本地工厂顶替，后续 rebase 对齐

---

## 任务地图（Files）

| 任务 | 文件 | 动作 |
|---|---|---|
| T1 | `apps/desktop/src/main.js` | Modify：窗口集合化 + per-webContents 状态 + 协议导航参数化 |
| T1 | `apps/desktop/test/window-multi-window.test.js` | Create：源码断言测试 |
| T2 | `apps/desktop/src/main.js` | Modify：菜单 + 新窗口 IPC |
| T2 | `apps/desktop/src/preload.cjs` | Modify：`openNewWindow(url)` |
| T2 | `apps/web/src/types/electron.d.ts` | Modify：`DesktopAPI.openNewWindow` 类型 |
| T2 | `apps/desktop/test/window-new-window.test.js` | Create：源码断言测试 |
| T3 | `apps/web/src/stores/vaultStore.ts` | Modify：URL 优先初始化 |
| T3 | `apps/web/src/components/kb/KnowledgeBasePage.tsx` | Modify：URL→store 同步 + file-nav 保 vault + store→URL 镜像 |
| T3 | `apps/web/e2e/multi-window.spec.ts` | Create：URL 驱动 vault 隔离 E2E |
| T4 | `apps/web/src/stores/kbTabsStore.ts` | Modify：改 `createTabsStore(vaultId)` 工厂 |
| T4 | `apps/web/src/hooks/useKbTabs.ts` | Modify：`useKbTabs(vaultId)` |
| T4 | `apps/web/src/components/kb/KnowledgeBasePage.tsx` | Modify：传 vaultId、镜像 effect 联动 |
| T4 | `apps/web/e2e/multi-window.spec.ts` | Modify：补 tabs 分片用例 |
| T5 | `apps/web/src/hooks/useKbChat.ts` | Modify：vault 切换重置 `conversationIdRef` |
| T5 | `apps/web/e2e/multi-window.spec.ts` | Modify：补会话重置用例 |
| T6 | `apps/web/src/utils/openWindow.ts` | Create：新窗口适配层 |
| T6 | `apps/web/src/components/kb/ContextMenu.tsx` | Modify：MenuItem 支持 `testid` |
| T6 | `apps/web/src/components/kb/KbTabBar.tsx` | Modify：标签右键「在新窗口打开」 |
| T6 | `apps/web/src/components/kb/KnowledgeBasePage.tsx` | Modify：`onOpenInNewWindow` handler + 传 `?vault=` |
| T6 | `apps/web/e2e/multi-window.spec.ts` | Modify：补标签右键开新窗用例 |
| T8 | 视 P1 合并情况 | rebase + 对齐 `createTabsStore` 签名 |

---

## Task 1: Electron — 窗口集合化 + per-webContents 状态 + 协议导航参数化

**Files:**
- Modify: `apps/desktop/src/main.js`（模块级状态、`createWindow`、`loadApp`、`showDaemonErrorPage`、`isWaitingForApp`、`deliverNavigation`、`navigateFromProtocolUrl`、`second-instance`、`whenReady` 内 createWindow/updater/activate/loadApp、`molio:renderer-ready`）
- Create: `apps/desktop/test/window-multi-window.test.js`

**Interfaces:**
- Produces: `createWindow({ url } = {})` → `BrowserWindow`；`loadAppWindow(win, url = '')`；`showDaemonErrorPage(win)`；`isWaitingForApp(win)`；`deliverNavigation(win, target)`；`navigateFromProtocolUrl(protocolUrl, win)`；模块级 `appWindows: Set`、`lastFocusedAppWindow`、`rendererStates: Map<wcId, { ready, pending }>`、`daemonReady: boolean`
- Consumes: 既有 `forceQuit`、`daemonProcess`、`buildKnowledgeUrlFromProtocolTarget`、`parseMolioProtocolUrl`（不改）

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/window-multi-window.test.js`：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');

describe('main.js multi-window (P2) — window collection', () => {
  it('replaces the single mainWindow global with an appWindows Set', () => {
    assert.ok(
      !/\blet mainWindow = null\b/.test(mainSource) && /\bconst appWindows = new Set\(\)/.test(mainSource),
      'single mainWindow global must be replaced by appWindows Set',
    );
  });

  it('createWindow accepts a url param and loads it in dev and prod', () => {
    assert.match(mainSource, /function createWindow\(\{ url/);
    assert.match(mainSource, /localhost:5173\s*\+\s*url/);
    assert.match(mainSource, /localhost:3100\s*\+\s*url/);
  });

  it('tracks and clears the last focused app window', () => {
    assert.match(mainSource, /lastFocusedAppWindow/);
    assert.match(mainSource, /appWindows\.delete\(win\)/);
  });

  it('updater and window-all-closed survive multi-window', () => {
    assert.ok(mainSource.includes("ipcMain.handle('app:restart'"), 'restart IPC untouched');
    assert.match(mainSource, /window-all-closed/);
  });
});

describe('main.js multi-window (P2) — per-webContents renderer state', () => {
  it('tracks renderer readiness per webContents in a Map', () => {
    assert.match(mainSource, /rendererStates\s*=\s*new Map/);
  });

  it('routes molio:renderer-ready via event.sender', () => {
    assert.ok(
      mainSource.includes("ipcMain.on('molio:renderer-ready', (event)") &&
        mainSource.includes('event.sender'),
      'renderer-ready must resolve the sending webContents from event.sender',
    );
  });

  it('resets renderer state on did-start-loading per window', () => {
    assert.match(mainSource, /did-start-loading[\s\S]*?rendererStates\.delete/);
  });

  it('deliverNavigation and isWaitingForApp take a target window', () => {
    assert.match(mainSource, /function deliverNavigation\(win, target\)/);
    assert.match(mainSource, /function isWaitingForApp\(win\)/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/desktop && node --test test/window-multi-window.test.js`
Expected: FAIL（main.js 仍是单 `mainWindow`，断言不满足）

- [ ] **Step 3: 实现 — 模块级状态**

把 main.js 顶部（约 36-48 行）替换为：

```js
/** All open application windows (feishu login windows are NOT tracked here). */
const appWindows = new Set();
/** Most recently focused application window — target for second-instance/activate. */
let lastFocusedAppWindow = null;
/**
 * Per-webContents renderer readiness. A full page load (cold-start loadApp or
 * any reload) recreates the renderer context, so the previous molio:navigate
 * listener is gone and molio:renderer-ready fires again once the SPA re-mounts.
 * Map<webContentsId, { ready: boolean, pending: { vaultId, filePath } | null }>
 */
const rendererStates = new Map();
let daemonProcess = null;
let stopDaemonMetrics = null;
let daemonReady = false;
```

删除 `let mainWindow = null;`、`let rendererReady = false;`、`let pendingNavigation = null;`。

- [ ] **Step 4: 实现 — createWindow 泛化**

把 `createWindow()`（约 195-281 行）改为：

```js
function createWindow({ url = '' } = {}) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Molio',
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  appWindows.add(win);
  win.on('focus', () => { lastFocusedAppWindow = win; });
  win.on('closed', () => {
    appWindows.delete(win);
    if (lastFocusedAppWindow === win) lastFocusedAppWindow = null;
    rendererStates.delete(win.webContents.id);
  });

  win.webContents.on('did-start-loading', () => {
    rendererStates.delete(win.webContents.id);
  });

  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isDevtoolsToggle =
      (input.key === 'F12') ||
      (input.key === 'I' && (input.control || input.meta) && input.shift);
    if (!isDevtoolsToggle) return;
    event.preventDefault();
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  });

  // macOS: hide instead of close to preserve renderer state.
  win.on('close', (event) => {
    if (process.platform === 'darwin' && !forceQuit) {
      event.preventDefault();
      win.hide();
    }
  });

  if (isDevMode()) {
    // Dev-only show path (ARMS injection only matters in prod — see original
    // comment). Without this the window stays hidden forever in dev.
    win.once('ready-to-show', () => win.show());
    win.webContents.openDevTools();
    win.loadURL('http://localhost:5173' + url);
  }
  // Production: first window is loaded by loadAppWindow() once daemon is ready;
  // additional windows load the same way (daemon already up → show immediately).
  return win;
}
```

- [ ] **Step 5: 实现 — loadApp/showDaemonErrorPage/isWaitingForApp/deliverNavigation/navigateFromProtocolUrl 参数化**

`loadApp()`（约 284-308 行）改为 `loadAppWindow(win, url)`：

```js
function loadAppWindow(win, url = '') {
  if (!win || win.isDestroyed()) return;
  log('info', 'main', `daemon ready — loading app window url=${url}`);
  win.loadURL('http://localhost:3100' + url);
  const wc = win.webContents;
  const onFinish = () => {
    wc.removeListener('did-fail-load', onFail);
    win.show();
  };
  const onFail = (_event, code, desc) => {
    wc.removeListener('did-finish-load', onFinish);
    log('error', 'main', `app load failed: code=${code} desc=${desc}`);
    showDaemonErrorPage(win);
  };
  wc.once('did-finish-load', onFinish);
  wc.once('did-fail-load', onFail);
}
```

`showDaemonErrorPage()`（318-333 行）加 `win` 参数，内部 `mainWindow` → `win`。`isWaitingForApp()`（340-344 行）→ `isWaitingForApp(win)`，`mainWindow` → `win`。

`deliverNavigation()`（391-406 行）→ per-webContents：

```js
function deliverNavigation(win, target) {
  if (!win || win.isDestroyed()) return;
  const state = rendererStates.get(win.webContents.id);
  if (state?.ready) {
    log('info', 'main', `in-page navigate: vault=${target.vaultId ?? '(active)'} file=${target.filePath}`);
    win.webContents.send('molio:navigate', {
      vaultId: target.vaultId,
      filePath: target.filePath,
    });
  } else {
    rendererStates.set(win.webContents.id, { ready: false, pending: { ...target } });
    log('info', 'main', `renderer not ready — queued navigate: vault=${target.vaultId ?? '(active)'} file=${target.filePath}`);
  }
}
```

`navigateFromProtocolUrl()`（419-456 行）→ 加 `win` 参数，命中目标窗口：

```js
function navigateFromProtocolUrl(protocolUrl, win) {
  const targetWin = win && !win.isDestroyed() ? win : lastFocusedAppWindow ?? appWindows.values().next().value;
  if (!targetWin || targetWin.isDestroyed()) return;

  try {
    const target = parseMolioProtocolUrl(protocolUrl);
    if (target?.action === 'open-file') {
      const state = rendererStates.get(targetWin.webContents.id);
      if (isWaitingForApp(targetWin) || !state?.ready) {
        const appUrl = buildKnowledgeUrlFromProtocolTarget(target);
        log('info', 'main', `navigating to ${appUrl} (renderer ${state?.ready ? 'waiting for app' : 'not ready'})`);
        rendererStates.set(targetWin.webContents.id, { ready: false, pending: null }); // loadURL supersedes stale queued nav
        targetWin.loadURL(appUrl);
      } else {
        deliverNavigation(targetWin, target);
      }
      return;
    }

    if (target?.action === 'launch') {
      if (isWaitingForApp(targetWin)) {
        loadAppWindow(targetWin);
      }
      return;
    }

    log('warn', 'main', `Unrecognized protocol URL: ${protocolUrl}`);
  } catch (e) {
    log('error', 'main', `Failed to parse protocol URL: ${protocolUrl}`);
  }
}
```

- [ ] **Step 6: 实现 — second-instance / whenReady / renderer-ready / activate**

`second-instance`（约 502-518 行）→ 聚焦最后聚焦窗口：

```js
app.on('second-instance', (_event, commandLine) => {
  const win = lastFocusedAppWindow ?? appWindows.values().next().value;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }
  const protocolUrl = commandLine.find(arg => arg.startsWith('molio://'));
  if (protocolUrl) {
    log('info', 'main', `second-instance triggered via ${protocolUrl}`);
    navigateFromProtocolUrl(protocolUrl, win);
  }
});
```

`whenReady`（532-626 行）内：
- `createWindow();` → `const firstWindow = createWindow();`
- `setupAutoUpdater(() => mainWindow, killDaemon);` → `setupAutoUpdater(() => lastFocusedAppWindow ?? (appWindows.values().next().value ?? null), killDaemon);`
- daemon 启动成功后加 `daemonReady = true;`（在 `startDaemonProduction()` 成功后）
- `loadApp();` → `loadAppWindow(firstWindow);`；`navigateFromProtocolUrl(protocolUrl)` → `navigateFromProtocolUrl(protocolUrl, firstWindow)`；`showDaemonErrorPage();` → `showDaemonErrorPage(firstWindow);`
- `app.on('open-url', ...)` 内的 `navigateFromProtocolUrl(url)` 保持（无 win → 落到聚焦窗口）

`activate`（613-625 行）→

```js
app.on('activate', () => {
  if (appWindows.size === 0) {
    const win = createWindow();
    if (!isDevMode() && daemonReady) loadAppWindow(win);
    return;
  }
  const win = lastFocusedAppWindow ?? appWindows.values().next().value;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});
```

`molio:renderer-ready`（737-747 行）→

```js
ipcMain.on('molio:renderer-ready', (event) => {
  const wc = event.sender;
  const id = wc.id;
  const state = rendererStates.get(id) ?? { ready: false, pending: null };
  const nav = state.pending;
  rendererStates.set(id, { ready: true, pending: null });
  if (nav && !wc.isDestroyed()) {
    log('info', 'main', `renderer ready — flushing queued navigate: vault=${nav.vaultId ?? '(active)'} file=${nav.filePath}`);
    wc.send('molio:navigate', nav);
  } else {
    log('info', 'main', 'renderer ready (no queued navigation to flush)');
  }
});
```

- [ ] **Step 7: 运行确认通过**

Run: `cd apps/desktop && node --test test/window-multi-window.test.js`
Expected: PASS（所有断言满足）

- [ ] **Step 8: 提交**

```bash
cd /Users/albert/workspace/Molio-feat-multi-window
git add apps/desktop/src/main.js apps/desktop/test/window-multi-window.test.js
git commit -m "feat(desktop): 多窗口基座 — appWindows 集合 + per-webContents renderer 状态 + 协议导航参数化"
```

---

## Task 2: Electron — 新窗口入口（菜单 + ⌘N/Ctrl+N + IPC + preload）

**Files:**
- Modify: `apps/desktop/src/main.js`（import Menu、`buildAppMenu`、`openNewWindowFromFocused`、`ipcMain.handle('app:new-window')`、whenReady 调 `buildAppMenu()`）
- Modify: `apps/desktop/src/preload.cjs`（`openNewWindow`）
- Modify: `apps/web/src/types/electron.d.ts`（`DesktopAPI.openNewWindow`）
- Create: `apps/desktop/test/window-new-window.test.js`

**Interfaces:**
- Consumes: Task 1 的 `createWindow({ url })`、`loadAppWindow(win, url)`、`appWindows`、`lastFocusedAppWindow`、`daemonReady`
- Produces: `window.__electron__.openNewWindow(url: string): Promise<void>`（Web 侧 Task 6 消费）；菜单「文件→新窗口」⌘N/Ctrl+N

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/window-new-window.test.js`：

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');
const preloadSource = readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf-8');

describe('main.js new-window entry (P2)', () => {
  it('builds an application menu with a New Window item + accelerator', () => {
    assert.ok(mainSource.includes('Menu.setApplicationMenu'), 'must set an app menu');
    assert.match(mainSource, /新窗口/);
    assert.match(mainSource, /CmdOrCtrl\+N/);
    assert.ok(mainSource.includes('editMenu') && mainSource.includes('windowMenu'), 'standard roles must be kept');
  });

  it('registers app:new-window IPC creating a window with a url', () => {
    assert.ok(mainSource.includes("ipcMain.handle('app:new-window'"));
    assert.match(mainSource, /createWindow\(\{ url/);
  });

  it('clones the focused window url for a new window', () => {
    assert.ok(mainSource.includes('openNewWindowFromFocused'));
    assert.ok(mainSource.includes('getURL'), 'must read focused window url');
  });
});

describe('preload openNewWindow bridge (P2)', () => {
  it('exposes openNewWindow via app:new-window IPC', () => {
    assert.ok(preloadSource.includes('openNewWindow'));
    assert.ok(preloadSource.includes("invoke('app:new-window'"));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/desktop && node --test test/window-new-window.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 — main.js 菜单 + IPC**

main.js 顶部 import 加 `Menu`：`import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron';`

新增（放在 `createWindow` 之前）：

```js
/**
 * Build the application menu. Multi-window replaces the default menu, so the
 * standard Edit/View/Window roles are kept (copy/paste/DevTools depend on
 * them). New Window (⌘N / Ctrl+N) clones the focused window's URL — the
 * daemon is per-process, so every window shares one backend.
 */
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新窗口', accelerator: 'CmdOrCtrl+N', click: () => openNewWindowFromFocused() },
        ...(isMac ? [] : [{ role: 'quit', label: '退出' }]),
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Open a new window that clones the focused window's current path+query. */
function openNewWindowFromFocused() {
  const win = lastFocusedAppWindow ?? appWindows.values().next().value;
  // Before the daemon is up there is nothing useful to clone and the window
  // would stay blank — focus the first window instead.
  if (!isDevMode() && !daemonReady) {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    return;
  }
  let url = '';
  if (win && !win.isDestroyed()) {
    try {
      const current = win.webContents.getURL();
      if (current) {
        const u = new URL(current);
        url = u.pathname + u.search;
      }
    } catch { url = ''; }
  }
  const newWin = createWindow({ url });
  if (!isDevMode() && daemonReady) loadAppWindow(newWin, url);
}
```

`ipcMain` handler（放在其它 IPC handler 区域）：

```js
// 渲染进程请求新开窗口（KB 标签「在新窗口打开」经 preload 到达）。
ipcMain.handle('app:new-window', (_event, payload) => {
  const url = typeof payload?.url === 'string' ? payload.url : '';
  const win = createWindow({ url });
  if (!isDevMode() && daemonReady) loadAppWindow(win, url);
  return { ok: true };
});
```

`whenReady` 内、`createWindow()` 之前加 `buildAppMenu();`。

- [ ] **Step 4: 实现 — preload + 类型**

`apps/desktop/src/preload.cjs` 的 `desktopAPI` 对象加（`onNavigate` 之后）：

```js
/**
 * Open a new Electron window loading the given SPA path (e.g. "/knowledge?vault=abc").
 * Used by the web layer's "在新窗口打开" action; in a plain browser the web
 * layer falls back to window.open().
 */
openNewWindow: (url) => ipcRenderer.invoke('app:new-window', { url }),
```

`apps/web/src/types/electron.d.ts` 的 `DesktopAPI` 接口加：

```ts
/** Open a new Electron window loading the given SPA path (e.g. "/knowledge?vault=abc"). */
openNewWindow: (url: string) => Promise<void>;
```

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/desktop && node --test test/window-new-window.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/main.js apps/desktop/src/preload.cjs apps/web/src/types/electron.d.ts apps/desktop/test/window-new-window.test.js
git commit -m "feat(desktop): 新窗口入口 — 菜单 ⌘N/Ctrl+N + app:new-window IPC + preload openNewWindow"
```

---

## Task 3: Web — URL 驱动 vault（vaultStore 初始化 + KB 页三 effect + E2E 建立）

**Files:**
- Modify: `apps/web/src/stores/vaultStore.ts`
- Modify: `apps/web/src/components/kb/KnowledgeBasePage.tsx`
- Create: `apps/web/e2e/multi-window.spec.ts`

**Interfaces:**
- Consumes: `vaultStore.setActiveVaultId`（既有）、`api`（既有）
- Produces: `readUrlVaultId()`（vaultStore 内）；KnowledgeBasePage 内 URL↔store 双向同步；E2E 里 `createVault(name, path): Promise<string>`、`deleteVault(id)` helper
- **关键点**：`?vault=` 是窗口权威；URL 不清除；`?file=` 瞬时、`pendingUrlNav` 持有

- [ ] **Step 1: 写失败 E2E**

`apps/web/e2e/multi-window.spec.ts`：

```ts
/**
 * @area knowledge
 * @priority P1
 *
 * Multi-window (P2): URL-driven vault isolation. Each Playwright context is one
 * "window" — contexts share nothing but the daemon + (if same browser context)
 * localStorage. Two separate contexts approximate two Electron windows.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const WEB = 'http://localhost:5173';
const DAEMON_API = 'http://localhost:3100/api';

async function createVault(name: string, vaultPath: string): Promise<string> {
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path: vaultPath }),
  });
  expect(res.ok).toBe(true);
  const listRes = await fetch(`${DAEMON_API}/knowledge/vaults`);
  const { vaults } = await listRes.json();
  const v = vaults.find((x: { path: string }) => x.path === vaultPath);
  if (!v) throw new Error(`vault ${name} not found after create`);
  return v.id as string;
}

async function deleteVault(id: string) {
  await fetch(`${DAEMON_API}/knowledge/vaults/${id}`, { method: 'DELETE' }).catch(() => {});
}

test.describe('multi-window vault isolation', () => {
  let vaultAId: string;
  let vaultBId: string;
  let dirA: string;
  let dirB: string;

  test.beforeAll(async () => {
    const ts = Date.now();
    dirA = `/tmp/molio-e2e-mw-a-${ts}`;
    dirB = `/tmp/molio-e2e-mw-b-${ts}`;
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(`${dirA}/alpha.md`, '# Alpha');
    writeFileSync(`${dirA}/beta.md`, '# Beta');
    writeFileSync(`${dirB}/gamma.md`, '# Gamma');
    vaultAId = await createVault('mw-a', dirA);
    vaultBId = await createVault('mw-b', dirB);
  });

  test.afterAll(async () => {
    await deleteVault(vaultAId);
    await deleteVault(vaultBId);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  test('two windows with different ?vault= show independent vault names', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await pageB.goto(`${WEB}/knowledge?vault=${vaultBId}`);
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a', { timeout: 5000 });
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b', { timeout: 5000 });
    await ctxA.close();
    await ctxB.close();
  });

  test('switching vault in one window reflects ?vault= and does not affect the other', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await pageB.goto(`${WEB}/knowledge?vault=${vaultBId}`);
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b');

    // Window A switches to vault B via the vault manager modal.
    await pageA.locator('.kb-vault-bar').click();
    await pageA.locator('.vm-vault-item', { hasText: 'mw-b' }).click();
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-b');

    // URL in window A now carries the new vault.
    await expect.poll(async () => new URL(pageA.url()).searchParams.get('vault')).toBe(vaultBId);
    // Window B untouched — still its own vault and URL.
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b');
    expect(new URL(pageB.url()).searchParams.get('vault')).toBe(vaultBId);
    await ctxA.close();
    await ctxB.close();
  });

  test('two pages SHARING localStorage (real Electron windows) stay vault-independent via ?vault=', async ({ browser }) => {
    // Electron 多窗口同一 session → 共享 localStorage。真实场景：⌘N 克隆窗口
    // 后两窗同在 vault A，用户把一窗切到 B。要防的是：A 页切 vault 写共享
    // `molio.activeVaultId=B` 后，B 页（模块级 store 已按自己 URL=?vault=A 初始化）
    // 不被串扰弹到 B。一个 context 里两个 page 模拟共享 localStorage。
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
    await pageB.goto(`${WEB}/knowledge?vault=${vaultAId}`); // 克隆场景：两窗同 vault A
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-a');

    // Page A 切到 vault B → 写共享 localStorage.activeVaultId=B、URL ?vault=B
    await pageA.locator('.kb-vault-bar').click();
    await pageA.locator('.vm-vault-item', { hasText: 'mw-b' }).click();
    await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-b');
    await expect.poll(async () => new URL(pageA.url()).searchParams.get('vault')).toBe(vaultBId);

    // Page B 仍绑定自己的 URL ?vault=A，不被共享 localStorage 的写串扰
    await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-a');
    await ctx.close();
  });

  test('?file= external navigation keeps ?vault= and opens the file', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${WEB}/knowledge?vault=${vaultAId}&file=alpha.md`);
    // File opens (rendered content appears) and the vault is kept in the URL.
    await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a', { timeout: 5000 });
    await expect.poll(() => new URL(page.url()).searchParams.get('vault')).toBe(vaultAId);
    // Transient ?file= is dropped from the URL (held in pendingUrlNav state).
    await expect.poll(() => new URL(page.url()).searchParams.get('file')).toBeNull();
    await ctx.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "vault"`（需 `pnpm dev` 运行中）
Expected: FAIL（URL `?vault=` 被现有代码 `setSearchParams({}, ...)` 清掉 / 切 vault 不写 URL）

- [ ] **Step 3: 实现 — vaultStore URL 优先初始化**

`apps/web/src/stores/vaultStore.ts` 加（`readPersistedVaultId` 之后）：

```ts
/**
 * Read ?vault= from the window URL — the per-window authoritative vault.
 * Each BrowserWindow / browser tab is a separate renderer, so this module-level
 * read is per-window. Fresh loads of /knowledge?vault=X initialize straight to X.
 */
function readUrlVaultId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('vault');
  } catch {
    return null;
  }
}
```

模块级初始化（`let activeVaultId` 处）改为：

```ts
let activeVaultId: string | null = readUrlVaultId() ?? readPersistedVaultId();
```

- [ ] **Step 4: 实现 — KnowledgeBasePage 三 effect**

把 `KnowledgeBasePage.tsx` 现有处理 URL 的 effect（约 151-163 行，`resolveUrlFileNavigation` 那段，包含 `setSearchParams({}, { replace: true })`）整体替换为三个 effect（**注意声明顺序，file-nav 必须在镜像 effect 之前**，否则镜像先清掉 `?file=` 会让 file-nav 漏接）：

```tsx
// URL → store: the window's ?vault= is the per-window source of truth. Fresh
// loads are handled by vaultStore module init; this catches in-app navigation
// that carries a vault param (graph double-click, new-window clone, protocol nav).
useEffect(() => {
  const urlVault = searchParams.get('vault');
  if (urlVault) vaultStore.setActiveVaultId(urlVault);
}, [searchParams, setSearchParams]);

// External file navigation (?vault=A&file=B): open the file, keep ?vault=,
// drop the transient ?file= (it is held in pendingUrlNav state).
useEffect(() => {
  const nav = resolveUrlFileNavigation(searchParams, kb);
  if (!nav) return;
  setPendingUrlNav(nav);
  setSearchParams({ vault: nav.vaultId }, { replace: true });
}, [searchParams, kb.vaults, kb.activeVault?.id, setSearchParams]);

// Store → URL mirror: whenever this window's active vault changes (switch,
// create, import, delete), reflect it into ?vault= so the URL stays an
// accurate serialization of the window. Must come AFTER the file-nav effect.
useEffect(() => {
  if (!kb.activeVault?.id) return;
  setSearchParams({ vault: kb.activeVault.id }, { replace: true });
}, [kb.activeVault?.id, setSearchParams]);
```

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "vault"`
Expected: PASS（3 个用例全绿）

同时跑既有回归：`cd apps/web && npx playwright test create-vault-form.spec.ts`（vault 切换路径未被破坏）
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/stores/vaultStore.ts apps/web/src/components/kb/KnowledgeBasePage.tsx apps/web/e2e/multi-window.spec.ts
git commit -m "feat(web): URL 驱动 vault — ?vault= 窗口级权威 + store 双向同步 + 多窗口 E2E"
```

---

## Task 4: Web — tabs 按 vault 分片（createTabsStore 工厂 + useKbTabs(vaultId)）

**Files:**
- Modify: `apps/web/src/stores/kbTabsStore.ts`（模块单例 → 工厂）
- Modify: `apps/web/src/hooks/useKbTabs.ts`
- Modify: `apps/web/src/components/kb/KnowledgeBasePage.tsx`
- Modify: `apps/web/e2e/multi-window.spec.ts`

**Interfaces:**
- Produces: `createTabsStore(vaultId: string): KbTabsStore`；`KbTabsStore` = 既有 store API + `destroy()`；`useKbTabs(vaultId: string | null): UseKbTabsReturn`
- Consumes: Task 3 的 `?vault=` 窗口级 vault → `useKbTabs(kb.activeVault?.id ?? null)`

- [ ] **Step 1: 扩展失败 E2E**

`multi-window.spec.ts` 的 describe 内追加：

```ts
test('tabs are scoped per vault across windows', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto(`${WEB}/knowledge?vault=${vaultAId}`);
  await pageB.goto(`${WEB}/knowledge?vault=${vaultBId}`);
  await expect(pageA.locator('.kb-vault-bar__name')).toHaveText('mw-a');
  await expect(pageB.locator('.kb-vault-bar__name')).toHaveText('mw-b');

  // Open alpha.md in window A and gamma.md in window B.
  await pageA.locator('.kb-tree-item', { hasText: 'alpha.md' }).first().click();
  await expect(pageA.locator('.kb-wtab', { hasText: 'alpha.md' })).toBeVisible();
  await pageB.locator('.kb-tree-item', { hasText: 'gamma.md' }).first().click();
  await expect(pageB.locator('.kb-wtab', { hasText: 'gamma.md' })).toBeVisible();

  // Each window only sees its own vault's tab.
  await expect(pageA.locator('.kb-wtab', { hasText: 'gamma.md' })).toHaveCount(0);
  await expect(pageB.locator('.kb-wtab', { hasText: 'alpha.md' })).toHaveCount(0);

  // Storage is keyed per vault.
  const keysA = await pageA.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('molio.kb.tabs')));
  const keysB = await pageB.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('molio.kb.tabs')));
  expect(keysA).toContain(`molio.kb.tabs.${vaultAId}`);
  expect(keysB).toContain(`molio.kb.tabs.${vaultBId}`);
  await ctxA.close();
  await ctxB.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "tabs"`
Expected: FAIL（两窗共享同一 `molio.kb.tabs`，window A 能看到 gamma.md 的 tab）

- [ ] **Step 3: 实现 — kbTabsStore 工厂化**

`apps/web/src/stores/kbTabsStore.ts`：把存储键参数化，模块级单例状态移入工厂闭包。持久化函数改为接收键：

```ts
function readPersistedTabs(storageKey: string): WorkspaceTab[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function readPersistedActiveTabId(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch { /* ignore */ }
  return null;
}

function persistState(tabsKey: string, activeKey: string, tabs: WorkspaceTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(tabsKey, JSON.stringify(tabs));
    if (activeTabId) localStorage.setItem(activeKey, activeTabId);
    else localStorage.removeItem(activeKey);
  } catch { /* storage unavailable */ }
}
```

导出工厂（原 `kbTabsStore` 对象体搬进闭包，`emit` 改为调用带键的 `persistState`，返回对象加 `destroy()`）：

```ts
export interface KbTabsStore {
  subscribe(cb: Listener): () => void;
  getTabs(): WorkspaceTab[];
  getActiveTabId(): string | null;
  getActiveTab(): WorkspaceTab | undefined;
  openTab(tab: Omit<WorkspaceTab, 'id'> & { id?: string }): { opened: boolean; reason?: 'limit' };
  closeTab(id: string): void;
  removeWhere(predicate: (t: WorkspaceTab) => boolean): string[];
  activateTab(id: string): void;
  updateTab(id: string, patch: Partial<WorkspaceTab>): void;
  /** Release listeners when the owning window/vault store is unmounted. */
  destroy(): void;
}

export function createTabsStore(vaultId: string): KbTabsStore {
  const tabsKey = `molio.kb.tabs.${vaultId}`;
  const activeKey = `molio.kb.activeTabId.${vaultId}`;
  let tabs: WorkspaceTab[] = readPersistedTabs(tabsKey);
  let activeTabId: string | null = readPersistedActiveTabId(activeKey);
  const listeners = new Set<Listener>();

  function emit() {
    persistState(tabsKey, activeKey, tabs, activeTabId);
    for (const l of listeners) l();
  }

  return {
    subscribe(cb: Listener) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    getTabs() { return tabs; },
    getActiveTabId() { return activeTabId; },

    getActiveTab(): WorkspaceTab | undefined {
      return tabs.find((t) => t.id === activeTabId);
    },

    openTab(tabInput: Omit<WorkspaceTab, 'id'> & { id?: string }): { opened: boolean; reason?: 'limit' } {
      const id = tabInput.id ?? `${tabInput.type}:${Math.random().toString(36).slice(2, 9)}`;
      const existing = tabs.find((t) => t.id === id);
      if (existing) {
        if (activeTabId !== id) {
          activeTabId = id;
          emit();
        }
        return { opened: false };
      }
      if (tabs.length >= MAX_TABS) {
        return { opened: false, reason: 'limit' };
      }
      const newTab: WorkspaceTab = { ...tabInput, id };
      tabs = [...tabs, newTab];
      activeTabId = id;
      emit();
      return { opened: true };
    },

    closeTab(id: string) {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const next = tabs.filter((t) => t.id !== id);
      tabs = next;
      if (activeTabId === id) {
        const newActive = next[idx - 1] ?? next[0] ?? null;
        activeTabId = newActive?.id ?? null;
      }
      emit();
    },

    removeWhere(predicate: (t: WorkspaceTab) => boolean): string[] {
      const removed = tabs.filter(predicate);
      if (removed.length === 0) return [];
      const removedIds = new Set(removed.map((t) => t.id));
      const survivors = tabs.filter((t) => !removedIds.has(t.id));
      tabs = survivors;
      if (activeTabId && removedIds.has(activeTabId)) {
        activeTabId = survivors[0]?.id ?? null;
      }
      emit();
      return removed.map((t) => t.id);
    },

    activateTab(id: string) {
      if (!tabs.some((t) => t.id === id)) return;
      if (activeTabId !== id) {
        activeTabId = id;
        emit();
      }
    },

    updateTab(id: string, patch: Partial<WorkspaceTab>) {
      let changed = false;
      const newId = patch.id;
      tabs = tabs.map((t) => {
        if (t.id === id) {
          changed = true;
          return { ...t, ...patch };
        }
        return t;
      });
      if (changed && newId && activeTabId === id && id !== newId) {
        activeTabId = newId;
      }
      if (changed) emit();
    },

    destroy() { listeners.clear(); },
  };
}
```

> 原模块级 `kbTabsStore` 导出、`useKbTabsData`/`useKbActiveTabId` hooks 一并删除——由 `useKbTabs(vaultId)` 取代。`Listener`、`MAX_TABS`、`WorkspaceTab` 类型保持既有导出。

- [ ] **Step 4: 实现 — useKbTabs(vaultId)**

`apps/web/src/hooks/useKbTabs.ts` 改为：

```ts
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createTabsStore, type KbTabsStore, type WorkspaceTab } from '../stores/kbTabsStore';

export type { TabType, WorkspaceTab } from '../stores/kbTabsStore';
export { MAX_TABS } from '../stores/kbTabsStore';

export interface UseKbTabsReturn {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => { opened: boolean; reason?: 'limit' };
  closeTab: (id: string) => void;
  removeWhere: (predicate: (t: WorkspaceTab) => boolean) => string[];
  activateTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<WorkspaceTab>) => void;
  getActiveTab: () => WorkspaceTab | undefined;
}

const NOOP_SUBSCRIBE = () => () => {};

export function useKbTabs(vaultId: string | null): UseKbTabsReturn {
  const store = useMemo<KbTabsStore | null>(() => (vaultId ? createTabsStore(vaultId) : null), [vaultId]);

  // Release the previous vault's store listeners when vaultId changes.
  useEffect(() => () => store?.destroy(), [store]);

  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe(cb) : NOOP_SUBSCRIBE()), [store]);
  const getTabs = useCallback(() => store?.getTabs() ?? [], [store]);
  const getActiveTabId = useCallback(() => store?.getActiveTabId() ?? null, [store]);

  const tabs = useSyncExternalStore(subscribe, getTabs, getTabs);
  const activeTabId = useSyncExternalStore(subscribe, getActiveTabId, getActiveTabId);

  const openTab = useCallback(
    (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => store?.openTab(tab) ?? { opened: false, reason: 'limit' as const },
    [store],
  );
  const closeTab = useCallback((id: string) => store?.closeTab(id), [store]);
  const removeWhere = useCallback((p: (t: WorkspaceTab) => boolean) => store?.removeWhere(p) ?? [], [store]);
  const activateTab = useCallback((id: string) => store?.activateTab(id), [store]);
  const updateTab = useCallback((id: string, patch: Partial<WorkspaceTab>) => store?.updateTab(id, patch), [store]);
  const getActiveTab = useCallback(() => store?.getActiveTab(), [store]);

  return useMemo(
    () => ({ tabs, activeTabId, openTab, closeTab, removeWhere, activateTab, updateTab, getActiveTab }),
    [tabs, activeTabId, openTab, closeTab, removeWhere, activateTab, updateTab, getActiveTab],
  );
}
```

- [ ] **Step 5: 实现 — KnowledgeBasePage 传 vaultId**

`KnowledgeBasePage.tsx` 约 142 行：`const tabs = useKbTabs();` → `const tabs = useKbTabs(kb.activeVault?.id ?? null);`

> 注意 `kb` 在 `const kb = useKnowledge();` 已先行取得（142 行上方），顺序正确。

- [ ] **Step 6: 运行确认通过**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "tabs"` → PASS
回归：`cd apps/web && npx playwright test create-vault-form.spec.ts file-ref-navigation.spec.ts publish-flow.spec.ts` → PASS
Typecheck：`pnpm typecheck` → PASS

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/stores/kbTabsStore.ts apps/web/src/hooks/useKbTabs.ts apps/web/src/components/kb/KnowledgeBasePage.tsx apps/web/e2e/multi-window.spec.ts
git commit -m "feat(web): KB tabs 按 vault 分片 — createTabsStore(vaultId) 工厂 + useKbTabs(vaultId)"
```

---

## Task 5: Web — useKbChat 会话在 vault 切换时重置

**Files:**
- Modify: `apps/web/src/hooks/useKbChat.ts`
- Modify: `apps/web/e2e/multi-window.spec.ts`

**Interfaces:**
- Consumes: `useKbChat` 的 `opts.vaultPath`（既有）、`conversationIdRef`（既有）
- Produces: vaultPath 变化时 `conversationIdRef.current = null`（新会话不续旧 vault 线程）

- [ ] **Step 1: 扩展 E2E**

`multi-window.spec.ts` 追加（拦截 `POST /api/runs`，断言切 vault 后的 run 是全新会话且 cwd 指向新 vault）：

```ts
test('KB chat does not continue the old vault conversation after switching vault', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const runs: Array<{ cwd?: string; conversationId?: string }> = [];
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      runs.push({ cwd: body.cwd, conversationId: body.conversationId });
    }
    await route.continue();
  });

  await page.goto(`${WEB}/knowledge?vault=${vaultAId}`);
  await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a');
  await page.locator('.kb-tree-item', { hasText: 'alpha.md' }).first().click();
  await page.locator('[data-testid="kb-btn-ask-file"]').click();
  const input = page.locator('[data-testid="file-chat-panel"] [data-testid="composer-input"]');
  await input.fill('hello');
  await input.press('Enter');
  await expect.poll(() => runs.length).toBeGreaterThanOrEqual(1);
  const firstRun = runs[0]!;

  // Switch to vault B and send again.
  await page.locator('.kb-vault-bar').click();
  await page.locator('.vm-vault-item', { hasText: 'mw-b' }).click();
  await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-b');
  await page.locator('.kb-tree-item', { hasText: 'gamma.md' }).first().click();
  await page.locator('[data-testid="kb-btn-ask-file"]').click();
  const input2 = page.locator('[data-testid="file-chat-panel"] [data-testid="composer-input"]');
  await input2.fill('hello again');
  await input2.press('Enter');
  await expect.poll(() => runs.length).toBeGreaterThanOrEqual(2);
  const secondRun = runs[1]!;

  // The second run re-targets the new vault's cwd.
  expect(secondRun.cwd).toContain('molio-e2e-mw-b');
  // And must NOT continue the first run's conversation thread.
  expect(secondRun.conversationId).toBeFalsy();
  await ctx.close();
});
```

> **确定性说明**：`conversationId` 断言依赖首轮 run 已返回 conversationId（agent 可用时成立）。若 CI 无真实 agent，此断言可能恒为真（首轮即无 id），此时以 `secondRun.cwd` 指向新 vault 为主要信号；该行仍是真实回归防线。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "does not continue"`
Expected: FAIL——当前 `conversationIdRef` 不重置，切 vault 后 `POST /api/runs` 会带上旧 vault 的 `conversationId`

- [ ] **Step 3: 实现 — useKbChat 重置**

`apps/web/src/hooks/useKbChat.ts` 在 `conversationIdRef` 定义（约 69 行）之后加：

```ts
// A conversation is bound to a vault (cwd). Switching vault must not continue
// the previous vault's thread — reset the lineage so the next send starts fresh.
useEffect(() => {
  conversationIdRef.current = null;
}, [vaultPath]);
```

（`useEffect` 已在文件顶部 import；`vaultPath` 来自 `opts` 解构。）

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "does not continue"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/hooks/useKbChat.ts apps/web/e2e/multi-window.spec.ts
git commit -m "fix(web): KB 会话在 vault 切换时重置 conversationId，避免续写旧 vault 线程"
```

---

## Task 6: Web — 新窗口适配层 + KB 标签右键「在新窗口打开」

**Files:**
- Create: `apps/web/src/utils/openWindow.ts`
- Modify: `apps/web/src/components/kb/ContextMenu.tsx`（MenuItem 支持 `testid`）
- Modify: `apps/web/src/components/kb/KbTabBar.tsx`（标签右键菜单）
- Modify: `apps/web/src/components/kb/KnowledgeBasePage.tsx`（`onOpenInNewWindow` handler）
- Modify: `apps/web/e2e/multi-window.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `window.__electron__.openNewWindow`（Electron 模式）；`kb.activeVault?.id`、`WorkspaceTab`
- Produces: `openInNewWindow(path: string)`；`KbTabBarProps.onOpenInNewWindow?: (tab) => void`；`MenuItem.testid?: string`

- [ ] **Step 1: 扩展 E2E**

`multi-window.spec.ts` 追加：

```ts
test('tab context menu opens the file in a new window', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let popupUrl: string | null = null;
  page.on('popup', (p) => { popupUrl = p.url(); });

  await page.goto(`${WEB}/knowledge?vault=${vaultAId}`);
  await expect(page.locator('.kb-vault-bar__name')).toHaveText('mw-a');
  await page.locator('.kb-tree-item', { hasText: 'alpha.md' }).first().click();
  await expect(page.locator('.kb-wtab', { hasText: 'alpha.md' })).toBeVisible();

  // Right-click the tab → 在新窗口打开 (browser fallback = window.open → popup).
  await page.locator('.kb-wtab', { hasText: 'alpha.md' }).click({ button: 'right' });
  await page.locator('[data-testid="tab-open-in-new-window"]').click();

  await expect.poll(() => popupUrl).toContain(`vault=${vaultAId}`);
  await expect.poll(() => popupUrl).toContain('alpha.md');
  await ctx.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "tab context menu"`
Expected: FAIL（`tab-open-in-new-window` 不存在）

- [ ] **Step 3: 实现 — openWindow 适配层**

`apps/web/src/utils/openWindow.ts`：

```ts
/**
 * Open a Molio SPA path in a new window.
 *
 * In the Electron shell this opens a new BrowserWindow via the desktop preload
 * bridge (Task 2); in a plain browser (dev / web-only) it falls back to
 * window.open() — a new tab, the browser's equivalent of a new window.
 * WebUI-first: this layer only decides HOW to open; the caller decides WHAT URL.
 */
export function openInNewWindow(path: string): void {
  const electron = window.__electron__;
  if (electron?.openNewWindow) {
    void electron.openNewWindow(path);
  } else {
    window.open(path, '_blank');
  }
}
```

- [ ] **Step 4: 实现 — ContextMenu 支持 testid**

`apps/web/src/components/kb/ContextMenu.tsx`：
- `MenuItem` 加 `/** data-testid for stable E2E selection */ testid?: string;`
- 按钮渲染处加 `data-testid={item.testid}`：

```tsx
<button
  key={i}
  type="button"
  data-testid={item.testid}
  className={`ctx-menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}`}
  disabled={item.disabled}
  title={item.title}
  onClick={() => {
    item.onClick?.();
    onClose();
  }}
>
```

- [ ] **Step 5: 实现 — KbTabBar 右键菜单**

`apps/web/src/components/kb/KbTabBar.tsx`：
- Props 加 `onOpenInNewWindow?: (tab: WorkspaceTab) => void;`
- import `ContextMenu`
- 组件内加状态 `const [ctxMenu, setCtxMenu] = useState<{ tab: WorkspaceTab; x: number; y: number } | null>(null);`
- tab div 加 `onContextMenu`：

```tsx
<div
  key={tab.id}
  className={`kb-wtab ${isActive ? 'is-active' : ''}`}
  ref={isActive ? activeRef : null}
  onClick={() => onActivate(tab.id)}
  onContextMenu={(e) => {
    e.preventDefault();
    setCtxMenu({ tab, x: e.clientX, y: e.clientY });
  }}
  onMouseDown={(e) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose(tab.id);
    }
  }}
  title={tooltip}
>
```

- 组件末尾（`actions` 之后）渲染：

```tsx
{ctxMenu && (
  <ContextMenu
    items={[
      { label: '在新窗口打开', testid: 'tab-open-in-new-window', onClick: () => onOpenInNewWindow?.(ctxMenu.tab) },
    ]}
    position={{ x: ctxMenu.x, y: ctxMenu.y }}
    onClose={() => setCtxMenu(null)}
  />
)}
```

- [ ] **Step 6: 实现 — KnowledgeBasePage handler**

`KnowledgeBasePage.tsx`：
- import `openInNewWindow` from '../../utils/openWindow'
- 加 handler：

```tsx
const handleOpenInNewWindow = useCallback((tab: WorkspaceTab) => {
  const vaultId = kb.activeVault?.id;
  if (!vaultId) return;
  const filePath = tab.id.startsWith('file:') ? tab.id.slice(5) : undefined;
  const url = `/knowledge?vault=${vaultId}${filePath ? `&file=${encodeURIComponent(filePath)}` : ''}`;
  openInNewWindow(url);
}, [kb.activeVault?.id]);
```

- `<KbTabBar ...>`（约 1019 行）加 `onOpenInNewWindow={handleOpenInNewWindow}`

- [ ] **Step 7: 运行确认通过**

Run: `cd apps/web && npx playwright test multi-window.spec.ts -g "tab context menu"` → PASS
Typecheck：`pnpm typecheck` → PASS

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/utils/openWindow.ts apps/web/src/components/kb/ContextMenu.tsx apps/web/src/components/kb/KbTabBar.tsx apps/web/src/components/kb/KnowledgeBasePage.tsx apps/web/e2e/multi-window.spec.ts
git commit -m "feat(web): 标签右键「在新窗口打开」+ openInNewWindow 适配层（Electron IPC / 浏览器 window.open）"
```

---

## Task 7: 全量验证

**Files:** 无新增。

- [ ] **Step 1: Typecheck + 单元测试**

```bash
pnpm typecheck
pnpm test
```
Expected: 全绿（daemon + desktop，含 T1/T2 新增的窗口测试）

- [ ] **Step 2: 全量 E2E**

`pnpm dev` 运行中，执行：`cd apps/web && npx playwright test`
Expected: 全绿（含 multi-window.spec.ts 全部用例 + 既有 P0/P1 回归）

- [ ] **Step 3: 手动桌面验证（Electron 壳，E2E 覆盖不到）**

`pnpm dev:desktop` 后逐项确认：
1. ⌘N/Ctrl+N 或菜单「文件→新窗口」→ 出现第二个窗口，克隆当前 URL
2. 两个窗口分别导航到不同 vault（`/knowledge?vault=X`）→ 文件树/tabs 各自独立
3. A 窗切 vault → A 窗 URL 变为 `?vault=`，B 窗不受影响
4. KB 标签右键「在新窗口打开」→ 新窗口直接打开该文件所在 vault
5. 全部关窗（非 mac）→ 应用退出；mac close → 隐藏、dock 可恢复
6. 单窗口默认路径行为与改造前一致
7. 剪藏（molio://open/...）落在最后激活窗口

- [ ] **Step 4: 提交（如有遗留）**

```bash
git add -A
git commit -m "chore(desktop,web): 多窗口全量验证通过"
```

---

## Task 8: P1 `createTabsStore()` 对齐（条件任务 — 仅 P1 #202 已合并时执行）

**Files:** 视 P1 合并后的签名而定。

- [ ] **Step 1: 检查 P1 是否已合并**

Run: `git log origin/main --oneline | grep -i "session-tabs\|createTabsStore" | head -3`
若为空 → 跳过本任务，本地工厂顶替（后续 rebase 时对齐）；若命中 → 继续。

- [ ] **Step 2: rebase main**

```bash
git checkout feat/multi-window && git rebase origin/main
```
解决与 P1 在 `kbTabsStore.ts` / `useKbTabs.ts` 上的冲突：以 P1 的 `createTabsStore()` 签名为准，把本计划的工厂实现对齐过去（行为不变：存储键按 vaultId 分片、`useKbTabs(vaultId)`）。

- [ ] **Step 3: 验证**

```bash
pnpm typecheck
cd apps/web && npx playwright test multi-window.spec.ts
```
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "refactor(web): 对齐 P1 createTabsStore() 原语签名"
```

---

## 自检记录（执行前已完成）

- **Spec 覆盖**：一窗一 vault（T3/T4）、URL 驱动 vault（T3）、tabs 分片（T4）、会话重置（T5）、入口=菜单+快捷键+标签右键（T2/T6）、active_vault 语义（无 daemon 改动，T1 起天然成立）、现在开工/P1 可选（T8 条件）✅
- **占位符**：无 TBD/TODO；每个代码步骤含可执行内容 ✅
- **类型一致性**：`createWindow({ url })`/`loadAppWindow(win, url)`/`deliverNavigation(win, target)`/`openInNewWindow(path)`/`useKbTabs(vaultId)`/`createTabsStore(vaultId)` 跨任务引用一致 ✅
- **已知取舍**：T5 的 conversationId 断言确定性依赖 agent 可用性，已在步骤内注明主要信号为 `secondRun.cwd` ✅
