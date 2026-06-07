import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
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

/** Find the system Node.js binary (not Electron's embedded one) */
function findSystemNode() {
  const isWin = process.platform === 'win32';
  try {
    // Windows uses where.exe, Unix (macOS/Linux) uses which
    const cmd = isWin ? 'where.exe' : 'which';
    const result = execFileSync(cmd, ['node'], { encoding: 'utf-8' }).trim();
    // Windows may return multiple lines, Unix returns a single path
    const nodePath = result.split(/\r?\n/)[0];
    if (nodePath) return nodePath;
  } catch { /* fall through */ }
  return 'node';
}

/** Start the daemon in production mode using the bundled resources */
function startDaemonProduction() {
  const daemonEntry = path.join(process.resourcesPath, 'daemon', 'daemon.js');
  const webStaticDir = path.join(process.resourcesPath, 'web');
  const nodeExe = findSystemNode();

  return new Promise((resolve, reject) => {
    daemonProcess = spawn(nodeExe, [daemonEntry], {
      env: {
        ...process.env,
        MOLIO_PORT: '3100',
        MOLIO_STATIC_DIR: webStaticDir,
      },
      stdio: 'pipe',
    });

    daemonProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      console.log(`[daemon] ${msg}`);
      if (msg.includes('listening on')) resolve();
    });

    daemonProcess.stderr?.on('data', (data) => {
      console.error(`[daemon] ${data.toString().trim()}`);
    });

    daemonProcess.on('exit', (code) => {
      console.log(`[daemon] exited with code ${code}`);
      daemonProcess = null;
    });

    daemonProcess.on('error', (err) => {
      reject(err);
    });

    // Timeout fallback
    setTimeout(() => resolve(), 10000);
  });
}

/** Create the main application window */
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

  // Open DevTools in development
  if (isDevMode()) {
    mainWindow.webContents.openDevTools();
  }

  if (isDevMode()) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
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
  // Do NOT exit — keep the updater running
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log('error', 'main', `unhandledRejection: ${msg}`);
  // Do NOT exit — keep the updater running
});

// ─── App lifecycle ───

app.whenReady().then(async () => {
  // ① Create window first (updater IPC needs getMainWindow reference)
  createWindow();

  // ② Set up auto-updater IMMEDIATELY — before daemon.
  // Even if daemon fails to start, the updater must be operational
  // so we can push fixes to users.
  setupAutoUpdater(() => mainWindow);

  // ③ Start daemon last — failure here must not affect updater
  if (!isDevMode()) {
    try {
      await startDaemonProduction();
    } catch (err) {
      log('error', 'main', `daemon startup failed: ${err?.message ?? err}`);
      // Daemon failure is not fatal for the updater.
      // The UI will show connection errors, but updates still work.
    }
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

app.on('before-quit', () => {
  if (daemonProcess) {
    daemonProcess.kill('SIGTERM');
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
