import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAutoUpdater } from './updater.js';
import { log } from './logger.js';

const errMsg = (err) => (err instanceof Error ? err.message : String(err));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTOCOL = 'molio';

// Set app name before any other app API calls — this controls the display name
// shown in Windows protocol association dialogs ("要打开 Molio 吗?").
app.name = 'Molio';

let mainWindow = null;
let daemonProcess = null;

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

    // Collect stderr for diagnostics if daemon fails to start
    const stderrChunks = [];
    let started = false;

    daemonProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
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
      if (code !== 0 && code !== null && stderrChunks.length > 0) {
        log('error', 'main', `daemon stderr:\n${stderrChunks.join('\n')}`);
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
 * Parse a molio:// protocol URL and navigate the Electron window accordingly.
 * Supported formats:
 *   molio://open?vault=<vaultId>&file=<filePath> — navigate to KB page and open file
 *   molio://launch — just bring window to front (no navigation)
 */
function navigateFromProtocolUrl(protocolUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const url = new URL(protocolUrl);
    const action = url.hostname; // 'open' or 'launch'

    if (action === 'open') {
      const vaultId = url.searchParams.get('vault');
      const filePath = url.searchParams.get('file');
      if (vaultId && filePath) {
        const target = `http://localhost:3100/knowledge?vault=${encodeURIComponent(vaultId)}&file=${encodeURIComponent(filePath)}`;
        log('info', 'main', `navigating to ${target}`);
        mainWindow.loadURL(target);
      }
    }
    // 'launch' action: no navigation needed, window already restored+focused
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
    // Handle molio:// protocol URL for navigation
    // Format: molio://open?vault=<vaultId>&file=<filePath>
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
  // ① Create window first (updater IPC needs getMainWindow reference)
  //    In production this shows splash.html while daemon starts.
  createWindow();

  // ② Set up auto-updater IMMEDIATELY — before daemon.
  // Even if daemon fails to start, the updater must be operational
  // so we can push fixes to users.
  // Pass killDaemon so the updater can release file locks before install.
  setupAutoUpdater(() => mainWindow, killDaemon);

  // ③ Start daemon last — failure here must not affect updater
  if (!isDevMode()) {
    try {
      await startDaemonProduction();
    } catch (err) {
      log('error', 'main', `daemon startup failed: ${err?.message ?? err}`);
      // Daemon failure is not fatal for the updater.
      // The UI will show connection errors, but updates still work.
    }

    // ④ Load the real app URL, or navigate to molio:// target if launched from protocol
    log('info', 'main', `process.argv: ${JSON.stringify(process.argv)}`);
    const protocolUrl = process.argv.find(arg => typeof arg === 'string' && arg.startsWith('molio://'));
    if (protocolUrl) {
      log('info', 'main', `detected protocol URL in argv: ${protocolUrl}`);
      // Defer navigation slightly to ensure daemon is fully ready
      setTimeout(() => navigateFromProtocolUrl(protocolUrl), 500);
    } else {
      loadApp();
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
        log('info', 'main', `daemon exited, waiting ${DAEMON_KILL_SETTLE_MS}ms for OS to release file handles`);
        setTimeout(resolve, DAEMON_KILL_SETTLE_MS);
      }
    };

    proc.once('exit', done);

    try {
      if (process.platform === 'win32' && pid) {
        // taskkill /F = force, /T = kill child processes too
        execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 });
        log('info', 'main', `taskkill sent for daemon pid=${pid}`);
      } else {
        proc.kill('SIGKILL');
      }
    } catch (err) {
      // Process may already be dead — that's fine
      log('warn', 'main', `killDaemon: ${err instanceof Error ? err.message : String(err)}`);
      done();
    }
  });
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
