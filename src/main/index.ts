import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { enforceSingleton } from './lifecycle.js';
import { registerIpcHandlers } from './ipc.js';
import { RunManager } from '../daemon/server.js';

// ── Singleton check ──
if (!enforceSingleton()) {
  process.exit(0);
}

// ── Daemon core ──
const runManager = new RunManager();
registerIpcHandlers(runManager);

// ── Window management ──
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Knowledge Growth Engine',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

// ── App lifecycle ──
app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    // macOS: re-create window when dock icon clicked and no windows
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Cancel all active runs before quitting
  runManager.cancelAll();
  app.quit();
});

// Graceful shutdown on SIGINT/SIGTERM
process.on('SIGINT', () => {
  runManager.cancelAll();
  app.quit();
});

process.on('SIGTERM', () => {
  runManager.cancelAll();
  app.quit();
});
