/**
 * Auto-update module for Molio desktop.
 *
 * Uses electron-updater to check for updates from GitHub Releases,
 * download them in the background, and notify the renderer when ready.
 *
 * In dev mode (not packaged), IPC handlers are registered but return
 * "not available" — autoUpdater requires a packaged app to function.
 */

import pkg from 'electron-updater';
import { app, ipcMain } from 'electron';

const { autoUpdater } = pkg;

// Silent background update: download automatically, notify only when ready
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const STARTUP_DELAY = 5_000;         // check 5s after launch
const POLL_INTERVAL = 60 * 60 * 1000; // check every hour

// Deduplicate concurrent check requests
let inFlightCheck = null;

function checkForUpdatesOnce() {
  if (inFlightCheck) return inFlightCheck;
  const p = autoUpdater
    .checkForUpdates()
    .then((result) => {
      void result?.downloadPromise?.catch((err) => {
        console.error('[updater] download failed:', err);
      });
      return result;
    })
    .finally(() => {
      if (inFlightCheck === p) inFlightCheck = null;
    });
  inFlightCheck = p;
  return p;
}

/**
 * Set up auto-updater events and IPC handlers.
 * IPC handlers are always registered so the renderer never gets a
 * "no handler" error. In dev mode they return a friendly message.
 *
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
export function setupAutoUpdater(getMainWindow) {
  const isPackaged = app.isPackaged;

  // IPC: manual check from renderer (Settings page "Check for updates" button)
  ipcMain.handle('updater:check', async () => {
    if (!isPackaged) {
      return {
        ok: true,
        currentVersion: app.getVersion(),
        latestVersion: app.getVersion(),
        available: false,
        devMode: true,
      };
    }
    try {
      const result = await checkForUpdatesOnce();
      const currentVersion = app.getVersion();
      return {
        ok: true,
        currentVersion,
        latestVersion: result?.updateInfo?.version ?? currentVersion,
        available: result?.isUpdateAvailable ?? false,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // IPC: install and restart
  ipcMain.handle('updater:install', () => {
    if (!isPackaged) return;
    autoUpdater.quitAndInstall(false, true);
  });

  // Only set up autoUpdater events and background polling in packaged builds
  if (!isPackaged) {
    console.log('[updater] dev mode — auto-update disabled, IPC handlers registered');
    return;
  }

  // Notify renderer when a new version is available
  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] v${info.version} available`);
    getMainWindow()?.webContents.send('updater:update-available', {
      version: info.version,
    });
  });

  // Forward download progress to renderer
  autoUpdater.on('download-progress', (progress) => {
    getMainWindow()?.webContents.send('updater:download-progress', {
      percent: progress.percent,
    });
  });

  // Notify renderer when update is downloaded and ready to install
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] v${info.version} downloaded`);
    getMainWindow()?.webContents.send('updater:update-downloaded', {
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err);
  });

  // Background check after startup delay
  setTimeout(() => {
    checkForUpdatesOnce().catch(console.error);
  }, STARTUP_DELAY);

  // Periodic polling
  setInterval(() => {
    checkForUpdatesOnce().catch(console.error);
  }, POLL_INTERVAL);
}
