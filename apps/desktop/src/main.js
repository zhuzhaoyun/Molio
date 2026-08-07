import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAutoUpdater } from './updater.js';
import { log, getLogPath } from './logger.js';
import { startFetchServer } from './wiki-fetcher.js';
import { openFeishuLogin, getFeishuLoginStatus } from './wiki-fetcher-login.js';
import { startDaemonMetricsPolling } from './daemon-metrics.js';
import { CappedBuffer } from './capped-buffer.js';

const errMsg = (err) => (err instanceof Error ? err.message : String(err));

// Dynamic import: monitoring-bundle.mjs is an esbuild-generated artifact
// (gitignored, produced by scripts/prepare-resources.mjs). In dev mode the
// file may not exist on a clean checkout before `prepare` runs, and a static
// import would throw at module evaluation — before the Electron ready event — crashing
// the app. This contradicts monitoring.js's design that "SDK init failure
// must never block app startup". try/catch keeps monitoring optional.
let initMonitoring = async () => null;
try {
  const mod = await import('./monitoring-bundle.mjs');
  if (typeof mod.initMonitoring === 'function') initMonitoring = mod.initMonitoring;
} catch (err) {
  log('warn', 'monitoring', `monitoring bundle not loaded: ${errMsg(err)}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTOCOL = 'molio';

// Set app name before any other app API calls — this controls the display name
// shown in Windows protocol association dialogs ("要打开 Molio 吗?").
app.name = 'Molio';

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

// On macOS, closing the window hides it instead of destroying it, so the
// user can reopen instantly from the dock. When the app is force-quitting
// (Cmd+Q / dock-quit), this flag is set to true so the close handler lets
// the window actually close.
let forceQuit = false;

/** Whether the app is running in development mode (not packaged) */
function isDevMode() {
  return !app.isPackaged;
}

/** Start the daemon in production mode using Electron's embedded Node.js */
async function startDaemonProduction() {
  const daemonEntry = path.join(process.resourcesPath, 'daemon', 'daemon.mjs');
  const webStaticDir = path.join(process.resourcesPath, 'web');

  log('info', 'main', `Starting daemon: ${daemonEntry}`);
  log('info', 'main', `Using Electron binary: ${process.execPath}`);

  // Start the wiki/docx fetcher HTTP server on a random 127.0.0.1 port.
  // Port 0 → OS assigns a free port; we pass it to the daemon via env so the
  // feishu service can pre-fetch wiki content before dispatching to the agent.
  // Failure here is non-fatal — daemon simply skips the pre-fetch step and
  // the agent sees the bare URL (with a "未启用桌面端抓取" note).
  let wikiFetchPort = null;
  try {
    wikiFetchPort = await startFetchServer();
  } catch (err) {
    log('warn', 'main', `wiki fetch server failed to start: ${err?.message ?? err}`);
  }

  return new Promise((resolve, reject) => {
    // Use Electron's embedded Node.js to run the daemon.
    // ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as a standard Node.js process,
    // eliminating the need for users to install Node.js separately.
    const daemonEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MOLIO_PORT: '3100',
      MOLIO_STATIC_DIR: webStaticDir,
    };
    if (wikiFetchPort) daemonEnv.MOLIO_DESKTOP_FETCH_PORT = String(wikiFetchPort);
    daemonProcess = spawn(process.execPath, [daemonEntry], {
      env: daemonEnv,
      stdio: 'pipe',
    });

    // Collect stderr/stdout for diagnostics if daemon fails to start.
    // Capped buffers: the previous plain arrays pushed every line forever,
    // so a day of runtime left a day of daemon output sitting in main
    // process memory. The tail (200 lines) is all exit diagnostics need.
    const stderrChunks = new CappedBuffer(200);
    const stdoutChunks = new CappedBuffer(200);
    let started = false;

    daemonProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      stdoutChunks.push(msg);
      log('info', 'daemon', msg);
      if (msg.includes('listening on')) {
        started = true;
        resolve();
      }
    });

    // Line-buffer daemon stderr: stderr 'data' events arrive as arbitrary chunks
    // (not aligned to newlines), so we accumulate and split on \n.
    //
    // Tiered forwarding to reduce ARMS noise:
    // - Lines containing real error indicators → console.error → ARMS
    //   consoleError collector → 异常统计. '[daemon]' prefix for filtering.
    // - Everything else (Node.js deprecation warnings, experimental API
    //   notices, debug output) → console.log → local log only, NOT
    //   captured by ARMS. This prevents non-actionable noise from
    //   flooding 异常统计 and filling the offline queue.
    // try/catch guards against any SDK throw breaking daemon log handling.
    const ERROR_LINE_RE = /\b(Error|FATAL|Exception|panic|ECONNREFUSED|ECONNRESET|ENOMEM)\b/;
    let stderrBuf = '';
    const flushDaemonLine = (line) => {
      if (!line) return;
      stderrChunks.push(line);
      if (ERROR_LINE_RE.test(line)) {
        log('error', 'daemon', line);
        try { console.error('[daemon] ' + line); } catch {}
      } else {
        log('info', 'daemon', line);
        try { console.log('[daemon] ' + line); } catch {}
      }
    };
    daemonProcess.stderr?.on('data', (data) => {
      stderrBuf += data.toString();
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        flushDaemonLine(line);
      }
    });

    daemonProcess.on('exit', (code, signal) => {
      // Flush any trailing partial line left in the buffer.
      flushDaemonLine(stderrBuf.trim());
      stderrBuf = '';
      log('error', 'main', `daemon exited with code=${code} signal=${signal}`);
      if (code !== 0 && code !== null) {
        if (stdoutChunks.length > 0) {
          log('error', 'main', `daemon stdout tail:\n${stdoutChunks.toArray().join('\n')}`);
        }
        if (stderrChunks.length > 0) {
          log('error', 'main', `daemon stderr tail:\n${stderrChunks.toArray().join('\n')}`);
        }
      }
      daemonProcess = null;
    });

    daemonProcess.on('error', (err) => {
      log('error', 'main', `daemon spawn error: ${err?.message ?? err}`);
      reject(err);
    });

    // Timeout fallback — reject so caller can skip loadApp()
    setTimeout(() => {
      if (!started) {
        log('warn', 'main', 'daemon startup timeout (10s) — rejecting');
        reject(new Error('Daemon startup timeout'));
      }
    }, 10000);
  });
}

/**
 * Create an application window.
 *
 * In production the window stays hidden (show: false) until the daemon is
 * ready and the real app URL has finished loading — then `loadAppWindow()`
 * shows it. We deliberately do NOT load splash.html first: the ARMS Browser
 * SDK auto-injection uses a per-webContents WeakSet, so a splash → app
 * navigation would inject the SDK into the splash page (whose JS context is
 * destroyed on navigation) and skip the real app, leaving API monitoring,
 * renderer JS errors, and interaction tracking all empty in the ARMS
 * console. One navigation = one injection = correct behaviour.
 *
 * The `backgroundColor` matches the app's dark theme so the brief blank
 * window (visible in the taskbar) doesn't flash white.
 *
 * `url` is the SPA path to load (e.g. "/knowledge?vault=abc"); dev mode
 * appends it to the Vite dev server, production passes it to loadAppWindow().
 */
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

  // Intercept window.open() — open in system browser instead of Electron
  // This is critical for the COSE publish flow: the bridge page must run
  // in the user's real Chrome (where the COSE extension is installed),
  // not in Electron's embedded Chromium.
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  // F12 / Ctrl+Shift+I toggles DevTools in production builds for debugging.
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

/** Load the real app URL after daemon is ready (production only). */
function loadAppWindow(win, url = '') {
  if (!win || win.isDestroyed()) return;
  log('info', 'main', `daemon ready — loading app window url=${url}`);
  win.loadURL('http://localhost:3100' + url);
  const wc = win.webContents;
  // Show the window once the app has rendered. This is the first (and
  // only) navigation for this webContents in production, so the ARMS
  // Browser SDK injection fires on the real app — not a throwaway splash.
  const onFinish = () => {
    wc.removeListener('did-fail-load', onFail);
    win.show();
  };
  // If the load fails — e.g. the daemon crashes between the readiness check
  // and the page actually loading, or a transient network error — Electron
  // fires did-fail-load instead of did-finish-load. Without this handler the
  // window would stay hidden forever with no feedback (the app looks dead).
  const onFail = (_event, code, desc) => {
    wc.removeListener('did-finish-load', onFinish);
    log('error', 'main', `app load failed: code=${code} desc=${desc}`);
    showDaemonErrorPage(win);
  };
  wc.once('did-finish-load', onFinish);
  wc.once('did-fail-load', onFail);
}

/**
 * Show a static error page when the daemon fails to start.
 *
 * Replaces the splash screen (which would otherwise spin forever) with a clear
 * message, the log file path, and actions to open the log folder or relaunch.
 * The log path is passed via query string so the page can display it without
 * needing Node integration.
 */
function showDaemonErrorPage(win) {
  if (!win || win.isDestroyed()) return;
  let logPath = null;
  try {
    logPath = getLogPath();
  } catch (err) {
    log('warn', 'main', `unable to resolve log path: ${err?.message ?? err}`);
  }
  log('error', 'main', `showing daemon error page (log=${logPath})`);
  const errorPage = path.join(__dirname, 'daemon-error.html');
  const query = logPath ? { log: logPath } : undefined;
  win.loadFile(errorPage, query ? { query } : undefined);
  win.webContents.once('did-finish-load', () => {
    win.show();
  });
}

/**
 * Whether the app URL has not been loaded yet (window is blank / waiting
 * for daemon). Formerly checked for splash.html; the splash page was
 * removed to fix ARMS Browser SDK injection (see createWindow comment).
 */
function isWaitingForApp(win) {
  if (!win || win.isDestroyed()) return false;
  const currentUrl = win.webContents.getURL();
  return currentUrl === '' || currentUrl === 'about:blank';
}

function parseMolioProtocolUrl(protocolUrl) {
  const vaultFileMatch = protocolUrl.match(/^molio:\/\/open\/vault\/([^/]+)\/file\/(.+)$/);
  if (vaultFileMatch) {
    return {
      action: 'open-file',
      vaultId: decodeURIComponent(vaultFileMatch[1]),
      filePath: decodeURIComponent(vaultFileMatch[2]),
    };
  }

  const fileOnlyMatch = protocolUrl.match(/^molio:\/\/open\/file\/(.+)$/);
  if (fileOnlyMatch) {
    return {
      action: 'open-file',
      vaultId: null,
      filePath: decodeURIComponent(fileOnlyMatch[1]),
    };
  }

  if (protocolUrl.startsWith('molio://launch')) {
    return { action: 'launch' };
  }

  return null;
}

function buildKnowledgeUrlFromProtocolTarget(target) {
  const params = new URLSearchParams();
  if (target.vaultId) params.set('vault', target.vaultId);
  params.set('file', target.filePath);
  return `http://localhost:3100/knowledge?${params.toString()}`;
}

/**
 * Deliver an open-file navigation to the renderer (warm-start path).
 *
 * If the renderer has mounted and registered its `molio:navigate` listener,
 * send the IPC for in-page routing (no reload, no state loss).
 *
 * If it hasn't yet — e.g. a clip just cold-launched Molio and the SPA is still
 * booting after loadApp() — queue the navigation. The renderer flushes it via
 * `molio:renderer-ready` once its listener is wired up. Without this queue,
 * the IPC would be delivered before the listener exists and the just-saved
 * file would never open.
 */
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

/**
 * Parse a molio:// protocol URL and navigate the Electron window accordingly.
 *
 * Uses path-style URLs (not query params) because Windows shell mangles `?` and
 * `&` when passing protocol URLs as command-line arguments.
 *
 * Supported formats:
 *   molio://open/vault/<vaultId>/file/<filePath> — navigate to KB page and open file
 *   molio://open/file/<filePath> — navigate using the active/default vault
 *   molio://launch — load app if still waiting for daemon; otherwise just bring window to front
 */
function navigateFromProtocolUrl(protocolUrl, win) {
  const targetWin = win && !win.isDestroyed() ? win : lastFocusedAppWindow ?? appWindows.values().next().value;
  if (!targetWin || targetWin.isDestroyed()) return;

  try {
    const target = parseMolioProtocolUrl(protocolUrl);
    if (target?.action === 'open-file') {
      const state = rendererStates.get(targetWin.webContents.id);
      // App not yet loaded, or renderer not yet ready: the in-page IPC path
      // can't deliver (no SPA listener, or a non-SPA page like the daemon
      // error page that never sends molio:renderer-ready, so a queued nav
      // would be dropped and the just-saved file never opens). Fall back to
      // a full loadURL of the knowledge route — the SPA reads ?vault=&file=
      // and opens the file. Reload is fine here since the renderer is already
      // in a broken/transient state; the warm healthy path uses IPC below.
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

    // molio://launch — if the app hasn't loaded yet (daemon still starting),
    // trigger loadAppWindow(). For second-instance launches, keep existing state.
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

// ─── App info IPC (sync, used by preload) ───

ipcMain.on('app:get-info', (event) => {
  const platform = process.platform;
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  event.returnValue = {
    version: app.getVersion(),
    os,
  };
});

// ─── Global crash protection ───
// These handlers prevent unhandled exceptions in non-critical subsystems
// (daemon, UI) from killing the main process and taking the auto-updater with it.
// The updater is the lifeline for pushing fixes, so it must survive all other failures.

process.on('uncaughtException', (err) => {
  log('error', 'main', `uncaughtException: ${err?.message ?? err}`);
  if (err?.stack) log('error', 'main', err.stack);
  // Keep the updater running so we can push fixes, but if the error is
  // unrecoverable (e.g. ENOMEM), exit gracefully after a short delay
  // rather than leaving the app in a corrupted state.
  if (err?.code === 'ENOMEM' || err?.code === 'ERR_IPC_CHANNEL_CLOSED') {
    log('error', 'main', 'fatal error — scheduling exit in 5s');
    setTimeout(() => app.quit(), 5000);
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log('error', 'main', `unhandledRejection: ${msg}`);
  // Do NOT exit — keep the updater running
});

// ─── Single-instance lock + custom protocol ───
// molio:// custom protocol allows external apps (Chrome extension) to launch Molio
// when daemon is not running. On Windows, setAsDefaultProtocolClient writes to registry;
// on macOS, it registers via Launch Services.

const singleLock = app.requestSingleInstanceLock();

if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Someone tried to launch via molio:// or double-click while app is running
    // Restore the existing (last-focused) window
    const win = lastFocusedAppWindow ?? appWindows.values().next().value;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
    // Handle molio:// protocol URL for navigation (path-style — see
    // parseMolioProtocolUrl; query-param form was abandoned due to Windows
    // mangling '?' and '&').
    const protocolUrl = commandLine.find(arg => arg.startsWith('molio://'));
    if (protocolUrl) {
      log('info', 'main', `second-instance triggered via ${protocolUrl}`);
      navigateFromProtocolUrl(protocolUrl, win);
    }
  });
}

// Register the custom protocol handler (idempotent — only writes if not already set)
// Must be called after app.whenReady() on Windows for registry writes to work.
// On macOS, setAsDefaultProtocolClient must be called before ready.
if (process.platform === 'darwin') {
  if (!app.isDefaultProtocolClient(PROTOCOL)) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

// ─── App lifecycle ───

app.whenReady().then(async () => {
  // Guard: requestSingleInstanceLock() returned false on a second instance,
  // but on some Electron versions whenReady still fires after app.quit().
  // If we proceed, the daemon startup below would spawn a second backend
  // whose port-conflict check kills the first instance's daemon — leaving
  // the running app with no backend. Bail out instead.
  if (!singleLock) {
    log('warn', 'main', 'whenReady fired without single-instance lock — second instance, quitting');
    app.quit();
    return;
  }
  // Register protocol on Windows (must be inside whenReady)
  if (process.platform !== 'darwin') {
    if (!app.isDefaultProtocolClient(PROTOCOL)) {
      const ok = app.setAsDefaultProtocolClient(PROTOCOL);
      if (ok) {
        log('info', 'main', `Protocol '${PROTOCOL}://' registered successfully`);
      } else {
        log('error', 'main', `Failed to register protocol '${PROTOCOL}://'`);
      }
    }
  }

  // 监控初始化必须在 createWindow 之前——SDK autoInject 监听 web-contents-created
  // 注入 Browser SDK，init 之前创建的窗口会错过注入。
  const armsRum = await initMonitoring({
    isDev: isDevMode(),
    version: app.getVersion(),
    log,
  });

  // ② Create window first (updater IPC needs a window reference).
  //    In production the window stays hidden until the daemon is ready.
  const firstWindow = createWindow();

  // ③ Set up auto-updater IMMEDIATELY — before daemon.
  // Even if daemon fails to start, the updater must be operational
  // so we can push fixes to users.
  // Pass killDaemon so the updater can release file locks before install.
  setupAutoUpdater(() => lastFocusedAppWindow ?? (appWindows.values().next().value ?? null), killDaemon);

  // ④ Start daemon last — failure here must not affect updater
  if (!isDevMode()) {
    try {
      await startDaemonProduction();
      daemonReady = true;
    } catch (err) {
      log('error', 'main', `daemon startup failed: ${err?.message ?? err}`);
      // Daemon failure is not fatal for the updater.
    }

    // ⑤ Bridge daemon memory metrics to ARMS (daemon has no ARMS SDK).
    if (daemonReady && armsRum) {
      stopDaemonMetrics = startDaemonMetricsPolling({ armsRum, log });
    }

    // ⑥ Only load the real app URL if daemon started successfully.
    // If launched via molio:// protocol, navigate to the target instead.
    if (daemonReady) {
      log('info', 'main', `process.argv: ${JSON.stringify(process.argv)}`);
      const protocolUrl = process.argv.find(arg => typeof arg === 'string' && arg.startsWith('molio://'));
      if (protocolUrl) {
        log('info', 'main', `detected protocol URL in argv: ${protocolUrl}`);
        // Defer navigation slightly to ensure daemon is fully ready
        setTimeout(() => navigateFromProtocolUrl(protocolUrl, firstWindow), 500);
      } else {
        loadAppWindow(firstWindow);
      }
    } else {
      showDaemonErrorPage(firstWindow);
    }
  }

  // macOS: handle open-url when app is not running
  app.on('open-url', (event, url) => {
    event.preventDefault();
    log('info', 'main', `open-url: ${url}`);
    navigateFromProtocolUrl(url);
  });

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/** Delay after daemon exit for Windows to release file handles (ms). */
const DAEMON_KILL_SETTLE_MS = 2000;

/**
 * Force-kill the daemon child process and wait for it to fully exit.
 *
 * Used before update install and on normal app quit to release file locks
 * in the installation directory. Without this, the NSIS installer fails with
 * "Failed to uninstall old application files" because the daemon holds
 * locks on files it needs to replace.
 *
 * On Windows, uses `taskkill /F /T` to reliably kill the entire process tree.
 * Node's proc.kill('SIGKILL') is unreliable on Windows — it may not kill
 * grandchild processes or release all handles promptly.
 *
 * @returns {Promise<void>}
 */
function killDaemon() {
  return new Promise((resolve) => {
    if (!daemonProcess) { resolve(); return; }
    const proc = daemonProcess;
    const pid = proc.pid;

    // Prevent double-resolve: exit event may fire after taskkill succeeds,
    // and the catch block may also fire if process is already dead.
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        if (forceTimer) {
          clearTimeout(forceTimer);
          forceTimer = null;
        }
        log('info', 'main', `daemon exited, waiting ${DAEMON_KILL_SETTLE_MS}ms for OS to release file handles`);
        setTimeout(resolve, DAEMON_KILL_SETTLE_MS);
      }
    };

    proc.once('exit', done);

    // Try a graceful shutdown first: ask the daemon to flush in-flight
    // assistant replies and exit on its own. Fall back to a force kill
    // if it does not exit within the timeout.
    requestDaemonShutdown();

    // Hard timeout: ensure we never block app quit indefinitely.
    let forceTimer = setTimeout(() => forceKillDaemon(pid), 5000);
  });
}

function requestDaemonShutdown() {
  fetch('http://localhost:3100/api/shutdown', { method: 'POST' }).catch((err) => {
    // Network errors are expected once the daemon is already shutting down.
    log('warn', 'main', `Graceful shutdown request failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function forceKillDaemon(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // taskkill /F = force, /T = kill child processes too
      execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 });
      log('info', 'main', `force taskkill sent for daemon pid=${pid}`);
    } else {
      daemonProcess?.kill('SIGKILL');
    }
  } catch (err) {
    // Process may already be dead — that's fine
    log('warn', 'main', `forceKillDaemon: ${err instanceof Error ? err.message : String(err)}`);
  }
}

app.on('before-quit', (event) => {
  // Signal the window close handler to actually close the window instead
  // of hiding it (macOS hide-on-close behavior).
  forceQuit = true;
  if (stopDaemonMetrics) { stopDaemonMetrics(); stopDaemonMetrics = null; }
  if (daemonProcess) {
    // Prevent the default quit until daemon is fully terminated.
    // Without this, Electron may exit before the daemon releases its
    // file handles, leaving locks in the installation directory that
    // cause the NSIS installer to fail on the next update.
    event.preventDefault();
    killDaemon().then(() => {
      app.quit();
    });
  }
});

// ─── IPC handlers ───

// Relaunch the app (used by the daemon-error page's "重启" button).
ipcMain.handle('app:restart', () => {
  log('info', 'main', 'app:restart requested — relaunching');
  app.relaunch();
  app.exit(0);
});

// Renderer signals it has mounted and registered its `molio:navigate`
// listener. Flush any navigation that was queued during cold start (before the
// listener existed), so a molio://open/... fired right after launch still
// opens the just-saved file instead of being dropped.
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

ipcMain.handle('show-directory-picker', async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) return null;
  const result = await dialog.showOpenDialog(focusedWindow, {
    properties: ['openDirectory'],
    title: '选择本地仓库文件夹',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-path', async (_, filePath) => {
  return shell.openPath(filePath);
});

// 在系统资源管理器中显示文件/文件夹
ipcMain.handle('show-item-in-folder', async (_, filePath) => {
  return shell.showItemInFolder(filePath);
});

// 用户在 FeishuChannelPanel 点击「登录飞书账号」 → 打开可见 BrowserWindow
// （feishu partition 跟 wiki-fetcher 共用），用户登录后 cookies 落到磁盘，
// 跨重启复用。targetUrl 可指定具体租户域名（如 geekbang.feishu.cn），
// 省略时打开 feishu.cn 让用户自行切换租户。
ipcMain.handle('molio:open-feishu-login', async (_, targetUrl) => {
  openFeishuLogin(typeof targetUrl === 'string' ? targetUrl : undefined);
  return { ok: true };
});

// 读取 feishu partition 的登录态（cookie 判定），供 FeishuChannelPanel 展示
// 「已登录 / 尚未登录」。跨重启准确（cookie 持久化在磁盘）。
ipcMain.handle('molio:get-feishu-login-status', async () => {
  return getFeishuLoginStatus();
});

// 重命名本地文件
ipcMain.handle('rename-file', async (_, oldPath, newPath) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  if (!fs.existsSync(oldPath)) {
    throw new Error('Source file not found');
  }
  if (fs.existsSync(newPath)) {
    throw new Error('Target already exists');
  }
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
  return newPath;
});
