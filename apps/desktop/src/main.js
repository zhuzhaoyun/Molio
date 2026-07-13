import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAutoUpdater } from './updater.js';
import { log, getLogPath } from './logger.js';
import { initMonitoring } from './monitoring-bundle.mjs';

const errMsg = (err) => (err instanceof Error ? err.message : String(err));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTOCOL = 'molio';

// Set app name before any other app API calls — this controls the display name
// shown in Windows protocol association dialogs ("要打开 Molio 吗?").
app.name = 'Molio';

let mainWindow = null;
let daemonProcess = null;

// Whether the renderer has mounted and registered its `molio:navigate`
// listener yet. On cold start the SPA doesn't mount until after the daemon is
// up and loadApp() runs — which is *after* the clipper's /api/health poll
// already reports ready. So a molio://open/... that fires right after launch
// (warm second-instance path) would reach a renderer that isn't listening yet
// and the IPC would be dropped, leaving the just-saved file unopened. We queue
// such navigations and flush them once the renderer signals readiness.
let rendererReady = false;
let pendingNavigation = null;

/** Whether the app is running in development mode (not packaged) */
function isDevMode() {
  return !app.isPackaged;
}

/** Start the daemon in production mode using Electron's embedded Node.js */
function startDaemonProduction() {
  const daemonEntry = path.join(process.resourcesPath, 'daemon', 'daemon.mjs');
  const webStaticDir = path.join(process.resourcesPath, 'web');

  log('info', 'main', `Starting daemon: ${daemonEntry}`);
  log('info', 'main', `Using Electron binary: ${process.execPath}`);

  return new Promise((resolve, reject) => {
    // Use Electron's embedded Node.js to run the daemon.
    // ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as a standard Node.js process,
    // eliminating the need for users to install Node.js separately.
    daemonProcess = spawn(process.execPath, [daemonEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MOLIO_PORT: '3100',
        MOLIO_STATIC_DIR: webStaticDir,
      },
      stdio: 'pipe',
    });

    // Collect stderr/stdout for diagnostics if daemon fails to start
    const stderrChunks = [];
    const stdoutChunks = [];
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

    daemonProcess.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      stderrChunks.push(msg);
      log('error', 'daemon', msg);
    });

    daemonProcess.on('exit', (code, signal) => {
      log('error', 'main', `daemon exited with code=${code} signal=${signal}`);
      if (code !== 0 && code !== null) {
        if (stdoutChunks.length > 0) {
          log('error', 'main', `daemon stdout tail:\n${stdoutChunks.slice(-20).join('\n')}`);
        }
        if (stderrChunks.length > 0) {
          log('error', 'main', `daemon stderr:\n${stderrChunks.join('\n')}`);
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

/** Create the main application window (shows splash in production). */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Molio',
    show: false, // Show after ready-to-show to avoid white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // Show window gracefully when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // A full page load (cold-start loadApp, or any reload) recreates the
  // renderer context, so the previous molio:navigate listener is gone and
  // molio:renderer-ready will fire again once the SPA re-mounts. Re-arm on
  // every did-start-loading so a queued navigation never gets delivered to a
  // stale listener that no longer exists.
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  // Intercept window.open() — open in system browser instead of Electron
  // This is critical for the COSE publish flow: the bridge page must run
  // in the user's real Chrome (where the COSE extension is installed),
  // not in Electron's embedded Chromium.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDevMode()) {
    mainWindow.webContents.openDevTools();
    mainWindow.loadURL('http://localhost:5173');
  } else {
    // Show splash while daemon starts — real URL is loaded in loadApp()
    mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  }
}

/** Load the real app URL after daemon is ready (production only). */
function loadApp() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log('info', 'main', 'daemon ready — loading app');
    mainWindow.loadURL('http://localhost:3100');
  }
}

/**
 * Show a static error page when the daemon fails to start.
 *
 * Replaces the splash screen (which would otherwise spin forever) with a clear
 * message, the log file path, and actions to open the log folder or relaunch.
 * The log path is passed via query string so the page can display it without
 * needing Node integration.
 */
function showDaemonErrorPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let logPath = null;
  try {
    logPath = getLogPath();
  } catch (err) {
    log('warn', 'main', `unable to resolve log path: ${err?.message ?? err}`);
  }
  log('error', 'main', `showing daemon error page (log=${logPath})`);
  const errorPage = path.join(__dirname, 'daemon-error.html');
  const query = logPath ? { log: logPath } : undefined;
  mainWindow.loadFile(errorPage, query ? { query } : undefined);
}

/** Whether the window is still showing the production splash screen. */
function isShowingSplash() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const currentUrl = mainWindow.webContents.getURL();
  return currentUrl === '' || currentUrl.includes('splash.html');
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
function deliverNavigation(target) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (rendererReady) {
    log('info', 'main', `in-page navigate: vault=${target.vaultId ?? '(active)'} file=${target.filePath}`);
    mainWindow.webContents.send('molio:navigate', {
      vaultId: target.vaultId,
      filePath: target.filePath,
    });
  } else {
    pendingNavigation = {
      vaultId: target.vaultId,
      filePath: target.filePath,
    };
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
 *   molio://launch — load app if still on splash; otherwise just bring window to front
 */
function navigateFromProtocolUrl(protocolUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const target = parseMolioProtocolUrl(protocolUrl);
    if (target?.action === 'open-file') {
      // Splash, error page, or renderer not yet ready: the in-page IPC path
      // can't deliver (no SPA listener, or a non-SPA page like the daemon
      // error page that never sends molio:renderer-ready, so a queued nav
      // would be dropped and the just-saved file never opens). Fall back to
      // a full loadURL of the knowledge route — the SPA reads ?vault=&file=
      // and opens the file. Reload is fine here since the renderer is already
      // in a broken/transient state; the warm healthy path uses IPC below.
      if (isShowingSplash() || !rendererReady) {
        const appUrl = buildKnowledgeUrlFromProtocolTarget(target);
        log('info', 'main', `navigating to ${appUrl} (renderer ${rendererReady ? 'on splash' : 'not ready'})`);
        pendingNavigation = null; // loadURL supersedes any stale queued nav
        mainWindow.loadURL(appUrl);
      } else {
        deliverNavigation(target);
      }
      return;
    }

    // molio://launch — if this is the initial launch, replace splash with the app.
    // For second-instance launches, the existing app window should keep its state.
    if (target?.action === 'launch') {
      if (isShowingSplash()) {
        loadApp();
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
    // Restore the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Handle molio:// protocol URL for navigation (path-style — see
    // parseMolioProtocolUrl; query-param form was abandoned due to Windows
    // mangling '?' and '&').
    const protocolUrl = commandLine.find(arg => arg.startsWith('molio://'));
    if (protocolUrl) {
      log('info', 'main', `second-instance triggered via ${protocolUrl}`);
      navigateFromProtocolUrl(protocolUrl);
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
  await initMonitoring({
    isDev: isDevMode(),
    version: app.getVersion(),
    log,
  });

  // ② Create window first (updater IPC needs getMainWindow reference)
  //    In production this shows splash.html while daemon starts.
  createWindow();

  // ③ Set up auto-updater IMMEDIATELY — before daemon.
  // Even if daemon fails to start, the updater must be operational
  // so we can push fixes to users.
  // Pass killDaemon so the updater can release file locks before install.
  setupAutoUpdater(() => mainWindow, killDaemon);

  // ④ Start daemon last — failure here must not affect updater
  if (!isDevMode()) {
    let daemonReady = false;
    try {
      await startDaemonProduction();
      daemonReady = true;
    } catch (err) {
      log('error', 'main', `daemon startup failed: ${err?.message ?? err}`);
      // Daemon failure is not fatal for the updater.
    }

    // ⑤ Only load the real app URL if daemon started successfully.
    // If launched via molio:// protocol, navigate to the target instead.
    if (daemonReady) {
      log('info', 'main', `process.argv: ${JSON.stringify(process.argv)}`);
      const protocolUrl = process.argv.find(arg => typeof arg === 'string' && arg.startsWith('molio://'));
      if (protocolUrl) {
        log('info', 'main', `detected protocol URL in argv: ${protocolUrl}`);
        // Defer navigation slightly to ensure daemon is fully ready
        setTimeout(() => navigateFromProtocolUrl(protocolUrl), 500);
      } else {
        loadApp();
      }
    } else {
      showDaemonErrorPage();
    }
  }

  // macOS: handle open-url when app is not running
  app.on('open-url', (event, url) => {
    event.preventDefault();
    log('info', 'main', `open-url: ${url}`);
    navigateFromProtocolUrl(url);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
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
ipcMain.on('molio:renderer-ready', () => {
  rendererReady = true;
  if (pendingNavigation && mainWindow && !mainWindow.isDestroyed()) {
    const nav = pendingNavigation;
    pendingNavigation = null;
    log('info', 'main', `renderer ready — flushing queued navigate: vault=${nav.vaultId ?? '(active)'} file=${nav.filePath}`);
    mainWindow.webContents.send('molio:navigate', nav);
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
