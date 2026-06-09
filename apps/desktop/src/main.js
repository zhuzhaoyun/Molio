import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAutoUpdater } from './updater.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    daemonProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      log('info', 'daemon', msg);
      if (msg.includes('listening on')) resolve();
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

    // Timeout fallback — resolve even if daemon never reports ready
    setTimeout(() => {
      log('warn', 'main', 'daemon startup timeout (10s) — resolving anyway');
      resolve();
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

// ─── App lifecycle ───

app.whenReady().then(async () => {
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

    // ④ Only load the real app URL AFTER daemon is ready.
    // Previously loadURL was called in createWindow() before daemon
    // started, causing 404/ECONNREFUSED on slower machines.
    loadApp();
  }

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

/**
 * Force-kill the daemon child process and wait for it to exit.
 *
 * Used before update install to release file locks in the installation
 * directory. Without this, the NSIS installer fails with
 * "Failed to uninstall old application files" because the daemon holds
 * locks on files it needs to replace.
 *
 * @returns {Promise<void>}
 */
function killDaemon() {
  return new Promise((resolve) => {
    if (!daemonProcess) { resolve(); return; }
    const proc = daemonProcess;
    proc.once('exit', () => {
      // Brief delay for the OS to release file handles
      setTimeout(resolve, 500);
    });
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  });
}

app.on('before-quit', () => {
  if (daemonProcess) {
    daemonProcess.kill('SIGKILL');
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
