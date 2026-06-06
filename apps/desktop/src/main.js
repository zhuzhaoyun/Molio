import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAutoUpdater } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let daemonProcess = null;

/** Whether the app is running in development mode (not packaged) */
function isDevMode() {
  return !app.isPackaged;
}

/** Find the system Node.js binary (not Electron's embedded one) */
function findSystemNode() {
  try {
    const result = execFileSync('where.exe', ['node'], { encoding: 'utf-8' }).trim();
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
        KGE_PORT: '3100',
        KGE_STATIC_DIR: webStaticDir,
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

// ─── App lifecycle ───

app.whenReady().then(async () => {
  if (!isDevMode()) {
    await startDaemonProduction();
  }
  createWindow();

  // Set up auto-updater IPC handlers (dev mode returns "not available")
  setupAutoUpdater(() => mainWindow);

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
