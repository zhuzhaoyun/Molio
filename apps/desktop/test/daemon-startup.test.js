/**
 * Regression test for: daemon fails to start when system Node.js is not installed.
 *
 * Root cause: startDaemonProduction() used findSystemNode() to find node.exe via
 * where.exe node. On systems without Node.js, the daemon never started.
 *
 * Fix: Use Electron's embedded Node.js via ELECTRON_RUN_AS_NODE=1 and
 * download Electron prebuilt binary for better-sqlite3 via prebuild-install.
 *
 * See: https://github.com/zhuzhaoyun/Molio/issues/21
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mainJs = readFileSync(
  path.resolve(import.meta.dirname, '../src/main.js'),
  'utf-8'
);

const prepareResourcesJs = readFileSync(
  path.resolve(import.meta.dirname, '../scripts/prepare-resources.mjs'),
  'utf-8'
);

describe('main.js: daemon must use Electron embedded Node.js (not system node)', () => {
  it('should NOT have findSystemNode() function', () => {
    assert.ok(
      !mainJs.includes('findSystemNode'),
      'findSystemNode() must be removed — daemon should use Electron embedded Node.js'
    );
  });

  it('should NOT import execFileSync (no longer needed for where.exe)', () => {
    assert.ok(
      !mainJs.includes('execFileSync'),
      'execFileSync must not be imported — where.exe lookup is no longer used'
    );
  });

  it('should spawn daemon with process.execPath', () => {
    assert.ok(
      mainJs.includes('process.execPath'),
      'startDaemonProduction must use process.execPath (Electron binary)'
    );
  });

  it('should set ELECTRON_RUN_AS_NODE=1 environment variable', () => {
    assert.ok(
      mainJs.includes('ELECTRON_RUN_AS_NODE'),
      'startDaemonProduction must set ELECTRON_RUN_AS_NODE=1'
    );
  });

  it('should pass daemonEntry as argument to spawn', () => {
    // spawn(process.execPath, [daemonEntry], ...)
    const spawnCall = mainJs.match(/spawn\(\s*process\.execPath\s*,\s*\[daemonEntry\]/);
    assert.ok(
      spawnCall,
      'spawn must be called with (process.execPath, [daemonEntry], ...)'
    );
  });

  it('should reference daemon.mjs (not daemon.js)', () => {
    assert.ok(
      mainJs.includes("daemon.mjs") || mainJs.includes('daemon.mjs'),
      'daemon entry must be daemon.mjs for ESM parsing by Electron embedded Node.js'
    );
  });
});

describe('main.js: must load URL only after daemon is ready (not in createWindow)', () => {
  it('createWindow should NOT call loadURL for production (localhost:3100)', () => {
    // Extract createWindow function body
    const fnStart = mainJs.indexOf('function createWindow({ url');
    assert.ok(fnStart !== -1, 'createWindow({ url }) must exist');

    const fnEnd = mainJs.indexOf('\nfunction ', fnStart + 1);
    const fnBody = mainJs.slice(fnStart, fnEnd);

    assert.ok(
      !fnBody.includes('localhost:3100') && !fnBody.includes('DAEMON_BASE'),
      'createWindow must NOT call loadURL for the daemon (localhost:3100/DAEMON_BASE) — that causes 404 on slow machines'
    );
  });

  it('createWindow should NOT load splash.html (ARMS Browser SDK injection fix)', () => {
    // The splash page caused the ARMS Browser SDK to inject into the splash
    // (whose JS context is destroyed on navigation) and skip the real app,
    // because the SDK's WeakSet prevents re-injection on the same webContents.
    // Production now keeps the window hidden until loadAppWindow() navigates
    // directly to localhost:3100 — one navigation = one correct injection.
    const fnStart = mainJs.indexOf('function createWindow({ url');
    const fnEnd = mainJs.indexOf('\nfunction ', fnStart + 1);
    const fnBody = mainJs.slice(fnStart, fnEnd);

    assert.ok(
      !fnBody.includes('splash.html'),
      'createWindow must NOT load splash.html — it breaks ARMS Browser SDK injection'
    );
    assert.ok(
      fnBody.includes('show: false'),
      'createWindow must keep the window hidden until loadAppWindow() shows it'
    );
  });

  it('loadAppWindow should call loadURL for localhost:3100', () => {
    assert.ok(
      mainJs.includes('function loadAppWindow('),
      'loadAppWindow function must exist'
    );

    const fnStart = mainJs.indexOf('function loadAppWindow(');
    const fnEnd = mainJs.indexOf('\nfunction ', fnStart + 1);
    const fnBody = mainJs.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 500);

    // 生产 URL 经 DAEMON_BASE 常量拼接（端口单点定义 DAEMON_PORT = 3100），
    // 不再有 'localhost:3100' 字面量。
    assert.ok(
      fnBody.includes('loadURL(DAEMON_BASE + url)'),
      'loadAppWindow must loadURL the daemon base URL'
    );
    assert.ok(
      mainJs.includes('const DAEMON_PORT = 3100') &&
        mainJs.includes('const DAEMON_BASE = `http://localhost:${DAEMON_PORT}`'),
      'DAEMON_BASE must be derived from the single DAEMON_PORT constant (:3100)'
    );
  });

  it('loadAppWindow should be called after startDaemonProduction in whenReady', () => {
    const whenReadyPos = mainJs.indexOf('app.whenReady()');
    assert.ok(whenReadyPos !== -1, 'app.whenReady() must exist');

    const whenReadyBlock = mainJs.slice(whenReadyPos);
    const daemonPos = whenReadyBlock.indexOf('startDaemonProduction');
    const loadAppPos = whenReadyBlock.indexOf('loadAppWindow(');

    assert.ok(daemonPos !== -1, 'startDaemonProduction must be in whenReady block');
    assert.ok(loadAppPos !== -1, 'loadAppWindow() must be in whenReady block');
    assert.ok(
      loadAppPos > daemonPos,
      `loadAppWindow() (pos ${loadAppPos}) must be called AFTER startDaemonProduction (pos ${daemonPos})`
    );
  });
});

describe('main.js: protocol launch should load app when daemon is not yet ready', () => {
  it('should parse molio://launch as a protocol target', () => {
    assert.ok(
      mainJs.includes('function parseMolioProtocolUrl'),
      'main.js must centralize molio:// protocol parsing'
    );
    assert.ok(
      mainJs.includes("return { action: 'launch' }"),
      'molio://launch must parse to a launch action'
    );
  });

  it('should detect when the app has not loaded yet (waiting for daemon)', () => {
    assert.ok(
      mainJs.includes('function isWaitingForApp('),
      'main.js must detect the blank-window state before handling molio://launch'
    );
    assert.ok(
      mainJs.includes('about:blank'),
      'waiting detection must check for the initial blank page'
    );
    assert.ok(
      mainJs.includes('webContents.getURL()'),
      'waiting detection must inspect the current BrowserWindow URL'
    );
  });

  it('molio://launch should call loadAppWindow when app has not loaded yet', () => {
    const navigatePos = mainJs.indexOf('function navigateFromProtocolUrl');
    assert.ok(navigatePos !== -1, 'navigateFromProtocolUrl must exist');

    // Window must cover the whole navigateFromProtocolUrl body, including the
    // open-file branch — otherwise the launch branch (which comes after it)
    // falls outside the slice and the assertions falsely fail.
    const navigateBlock = mainJs.slice(navigatePos, navigatePos + 2000);
    assert.ok(
      navigateBlock.includes("target?.action === 'launch'"),
      'navigateFromProtocolUrl must handle parsed launch actions'
    );
    assert.ok(
      navigateBlock.includes('isWaitingForApp(targetWin)'),
      'molio://launch handling must check if the app has not loaded yet'
    );
    assert.ok(
      navigateBlock.includes('loadAppWindow(targetWin)'),
      'molio://launch handling must load the real app when daemon is ready'
    );
  });

  it('should support file-only open protocol for single-prompt clip saves', () => {
    assert.ok(
      mainJs.includes('molio://open/file/'),
      'desktop protocol parser must support molio://open/file/<filePath>'
    );
    assert.ok(
      mainJs.includes("params.set('file', target.filePath)"),
      'file-only protocol target must navigate to the knowledge page with a file param'
    );
  });

  it('molio://open should fall back to loadURL when the renderer is not ready', () => {
    // Regression: when a stale Molio process holds the single-instance lock
    // with a dead daemon, the window shows the static daemon-error page (not
    // the SPA), so molio:renderer-ready never fires and a queued navigation
    // was silently dropped — the clip saved but the file never opened.
    // The fix: if rendererReady is false, loadURL the knowledge route
    // directly instead of queuing.
    const navigatePos = mainJs.indexOf('function navigateFromProtocolUrl');
    assert.ok(navigatePos !== -1, 'navigateFromProtocolUrl must exist');
    const navigateBlock = mainJs.slice(navigatePos, navigatePos + 2000);
    assert.ok(
      navigateBlock.includes('!state?.ready'),
      'open-file navigation must fall back to loadURL when the renderer is not ready'
    );
    assert.ok(
      /isWaitingForApp\(targetWin\)\s*\|\|\s*!state\?\.ready/.test(navigateBlock),
      'the loadURL fallback condition must cover both waiting-for-app and not-ready states'
    );
  });
});

describe('main.js: packaged daemon must get MOLIO_AUTH_URL (cloud auth wiring)', () => {
  // Regression: packaged builds never set MOLIO_AUTH_URL → daemon AuthClient
  // isConfigured()=false → /api/auth/* 回 503 auth_not_configured，Web UI 隐藏
  // 登录表单（「登录服务尚未配置」）。官方包必须内置云端地址，env 显式值优先
  // （私有化/Docker 靠自己的 MOLIO_AUTH_URL）。
  it('should define a built-in official auth URL', () => {
    assert.ok(
      mainJs.includes("const DEFAULT_AUTH_URL = 'https://auth.molio.cn'"),
      'main.js must define DEFAULT_AUTH_URL pointing at the official cloud'
    );
  });

  it('daemon env should fall back to DEFAULT_AUTH_URL when MOLIO_AUTH_URL is unset/blank', () => {
    assert.ok(
      /daemonEnv\.MOLIO_AUTH_URL\s*\?\?\s*''/.test(mainJs),
      'the fallback must treat a missing env as empty string'
    );
    assert.ok(
      mainJs.includes('daemonEnv.MOLIO_AUTH_URL = DEFAULT_AUTH_URL'),
      'startDaemonProduction must inject DEFAULT_AUTH_URL when the env is missing or blank'
    );
  });

  it('an explicitly set MOLIO_AUTH_URL must take precedence (no silent override)', () => {
    // 用户偏好规则：显式配置不得被静默覆盖——注入只能发生在条件分支里。
    const fallbackPos = mainJs.indexOf('daemonEnv.MOLIO_AUTH_URL = DEFAULT_AUTH_URL');
    assert.ok(fallbackPos !== -1, 'fallback injection must exist');
    const before = mainJs.slice(Math.max(0, fallbackPos - 300), fallbackPos);
    assert.ok(
      /if\s*\(/.test(before),
      'DEFAULT_AUTH_URL must only be injected inside a conditional — explicit env always wins'
    );
  });
});

describe('prepare-resources.mjs: better-sqlite3 must use Electron prebuild', () => {
  it('should use prebuild-install to download Electron prebuilt binary', () => {
    assert.ok(
      prepareResourcesJs.includes('prebuild-install'),
      'prepare-resources must use prebuild-install to download Electron prebuilt binary'
    );
  });

  it('should target electron runtime', () => {
    assert.ok(
      prepareResourcesJs.includes("'electron'") || prepareResourcesJs.includes('--runtime electron'),
      'prebuild-install must target electron runtime'
    );
  });

  it('should output daemon.mjs (not daemon.js) for ESM parsing', () => {
    assert.ok(
      prepareResourcesJs.includes('daemon.mjs'),
      'esbuild output must be daemon.mjs for ESM parsing by Electron embedded Node.js'
    );
  });

  it('should use electronVersion from electron/package.json', () => {
    assert.ok(
      prepareResourcesJs.includes('electronVersion'),
      'prebuild must use electronVersion from electron/package.json'
    );
  });

  it('should keep qrcode external and copy its runtime dependencies', () => {
    assert.ok(
      prepareResourcesJs.includes("'qrcode'"),
      'qrcode must stay external so its CommonJS fs requires work in the ESM daemon bundle'
    );
    assert.ok(
      prepareResourcesJs.includes("'dijkstrajs'") && prepareResourcesJs.includes("'pngjs'"),
      'qrcode runtime dependencies must be copied to desktop resources'
    );
  });
});

describe('main.js: daemon startup failure must show an error page, not spin forever', () => {
  // Regression: when startDaemonProduction() rejects (timeout/crash), the else
  // branch used to call showDaemonErrorPage() which was never defined. The
  // resulting ReferenceError was swallowed by uncaughtException, leaving the
  // window stuck on splash.html's spinner indefinitely.
  it('should define showDaemonErrorPage function', () => {
    assert.ok(
      /\bfunction\s+showDaemonErrorPage\s*\(/.test(mainJs),
      'showDaemonErrorPage must be defined so daemon failure shows an error page instead of an infinite spinner'
    );
  });

  it('should call showDaemonErrorPage in the daemon-not-ready else branch', () => {
    const elsePos = mainJs.indexOf('} else {');
    assert.ok(elsePos !== -1, 'whenReady must have an else branch for daemon-not-ready');
    const afterElse = mainJs.slice(elsePos);
    assert.ok(
      afterElse.includes('showDaemonErrorPage(firstWindow)'),
      'the daemon-not-ready else branch must call showDaemonErrorPage(firstWindow)'
    );
  });

  it('should load daemon-error.html from the error page', () => {
    assert.ok(
      mainJs.includes('daemon-error.html'),
      'showDaemonErrorPage must load daemon-error.html'
    );
  });

  it('should expose a restartApp action in preload for the error page', () => {
    const preload = readFileSync(
      path.resolve(import.meta.dirname, '../src/preload.cjs'),
      'utf-8'
    );
    assert.ok(
      preload.includes("restartApp") && preload.includes('app:restart'),
      'preload must expose restartApp() -> app:restart IPC for the error page restart button'
    );
  });

  it('should handle app:restart IPC with app.relaunch + exit', () => {
    const handlerPos = mainJs.indexOf("'app:restart'");
    assert.ok(handlerPos !== -1, "main.js must register an 'app:restart' IPC handler");
    const block = mainJs.slice(handlerPos, handlerPos + 200);
    assert.ok(block.includes('app.relaunch'), 'app:restart must call app.relaunch()');
    assert.ok(block.includes('app.exit'), 'app:restart must call app.exit() to quit the current instance');
  });
});

describe('main.js: daemon startup timeout must tolerate slow first launches', () => {
  // Regression: the first launch after packaging hit the old 10s timeout while
  // the daemon did cold-cache startup work before binding its port, showing
  // "后端服务启动失败" even though the daemon came up seconds later — a restart
  // "fixed" it. The gate must stay generous (>= 30s).
  it('should wait at least 30s for the daemon before rejecting', () => {
    const timeoutMatch = mainJs.match(/daemon startup timeout[\s\S]{0,200}?\},\s*(\d+)\)/);
    assert.ok(timeoutMatch, 'startup timeout fallback must exist');
    assert.ok(
      Number(timeoutMatch[1]) >= 30000,
      `startup timeout is ${timeoutMatch[1]}ms — must be >= 30000ms`
    );
  });

  it('should clear the startup timer once the daemon is ready', () => {
    assert.ok(
      mainJs.includes('clearTimeout(startupTimer)'),
      'the startup timer must be cleared when "listening on" arrives'
    );
  });
});

describe('main.js: early daemon exit must fail startup fast, not wait out the timer', () => {
  // Regression: when the daemon process died before printing "listening on",
  // the 'exit' handler only logged — the startup promise was never rejected,
  // so the app sat out the full 30s startup timer on a blank/spinning window
  // before finally showing the error page. Both failure paths ('exit' before
  // ready and spawn 'error') must also clear the timer so a settled promise
  // never leaves a pending 30s timeout behind.
  function handlerBlock(marker, endMarker) {
    const start = mainJs.indexOf(marker);
    assert.ok(start !== -1, `${marker} must exist in main.js`);
    const end = mainJs.indexOf(endMarker, start);
    return mainJs.slice(start, end > start ? end : start + 1500);
  }

  it('exit handler should reject immediately when the daemon was not started yet', () => {
    const exitBlock = handlerBlock("daemonProcess.on('exit'", "daemonProcess.on('error'");
    assert.ok(
      exitBlock.includes('if (!started)'),
      'the exit handler must detect a daemon that died before "listening on"'
    );
    // Window is generous: the reject carries an explanatory comment block.
    assert.ok(
      /if \(!started\)[\s\S]{0,800}?reject\(/.test(exitBlock),
      'the exit handler must reject the startup promise when the daemon exits early'
    );
  });

  it('exit handler should clear the startup timer', () => {
    const exitBlock = handlerBlock("daemonProcess.on('exit'", "daemonProcess.on('error'");
    assert.ok(
      exitBlock.includes('clearTimeout(startupTimer)'),
      'the exit handler must clear the startup timer so no 30s timeout lingers'
    );
  });

  it('spawn error handler should clear the startup timer', () => {
    const errorBlock = handlerBlock("daemonProcess.on('error'", 'startupTimer = setTimeout');
    assert.ok(
      errorBlock.includes('clearTimeout(startupTimer)'),
      'the spawn error handler must clear the startup timer when it rejects'
    );
  });
});

describe('main.js: graceful daemon shutdown to preserve last assistant reply', () => {
  it('should request /api/shutdown before force-killing daemon', () => {
    assert.ok(
      mainJs.includes('/api/shutdown'),
      'killDaemon must call the daemon shutdown endpoint so in-flight assistant replies can be flushed'
    );
    assert.ok(
      mainJs.includes('function requestDaemonShutdown'),
      'requestDaemonShutdown helper must exist'
    );
  });

  it('should fall back to force kill after a timeout', () => {
    const killDaemonStart = mainJs.indexOf('function killDaemon()');
    assert.ok(killDaemonStart !== -1, 'killDaemon function must exist');

    const killDaemonEnd = mainJs.indexOf('\nfunction requestDaemonShutdown', killDaemonStart);
    const killDaemonBlock = mainJs.slice(killDaemonStart, killDaemonEnd > killDaemonStart ? killDaemonEnd : killDaemonStart + 1200);
    assert.ok(
      killDaemonBlock.includes('setTimeout') && killDaemonBlock.includes('forceKillDaemon'),
      'killDaemon must schedule a force-kill fallback timeout'
    );
    assert.ok(
      killDaemonBlock.includes('forceTimer'),
      'killDaemon must clear the fallback timer once the daemon exits'
    );
  });
});

describe('main.js: loadAppWindow must handle did-fail-load so a failed load never leaves a dead hidden window', () => {
  // Regression: loadAppWindow() only listened for did-finish-load before
  // showing the window. If loadURL fails (daemon crashes between the readiness
  // check and the page loading, or a transient network error), Electron fires
  // did-fail-load instead — so the window stayed hidden forever with no
  // feedback and the app appeared completely dead.
  function loadAppBody() {
    const fnStart = mainJs.indexOf('function loadAppWindow(');
    assert.ok(fnStart !== -1, 'loadAppWindow function must exist');
    const fnEnd = mainJs.indexOf('\nfunction ', fnStart + 1);
    return mainJs.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1000);
  }

  it('loadAppWindow should register a did-fail-load handler', () => {
    assert.ok(
      loadAppBody().includes('did-fail-load'),
      'loadAppWindow must handle did-fail-load — otherwise a failed loadURL leaves the window hidden forever'
    );
  });

  it('did-fail-load handler should surface the daemon error page', () => {
    assert.ok(
      loadAppBody().includes('showDaemonErrorPage'),
      'on load failure loadAppWindow must show the daemon error page so the user gets feedback instead of a dead window'
    );
  });
});
