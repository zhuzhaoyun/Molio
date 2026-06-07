/**
 * Auto-update module for Molio desktop.
 *
 * Uses electron-updater to check for updates from GitHub Releases,
 * download them in the background, and notify the renderer when ready.
 *
 * Key design:
 * - Errors are logged to file AND surfaced to the renderer UI
 * - Failed checks retry with exponential backoff (not waiting a full hour)
 * - All activity is logged to {userData}/logs/updater.log for diagnosis
 *
 * In dev mode (not packaged), IPC handlers are registered but return
 * "not available" — autoUpdater requires a packaged app to function.
 */

import pkg from 'electron-updater';
import { app, ipcMain } from 'electron';
import { log } from './logger.js';

const { autoUpdater } = pkg;

// Silent background update: download automatically, notify only when ready
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const STARTUP_DELAY = 5_000;         // check 5s after launch
const POLL_INTERVAL = 60 * 60 * 1000; // check every hour

// Retry backoff delays on failure (ms): 30s → 1m → 2m → 5m → 15m
const RETRY_DELAYS = [30_000, 60_000, 120_000, 300_000, 900_000];

// Deduplicate concurrent check requests
let inFlightCheck = null;
let retryIndex = 0;
let retryTimer = null;
let pollTimer = null;

/**
 * Attempt a single update check.
 * On success: reset retry counter, schedule next poll.
 * On failure: log, notify renderer, schedule retry with backoff.
 */
function checkForUpdatesOnce() {
  if (inFlightCheck) return inFlightCheck;

  log('info', 'updater', 'checking for updates...');

  const p = autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (result?.isUpdateAvailable) {
        log('info', 'updater', `update available: v${result.updateInfo?.version}`);
      } else {
        log('info', 'updater', 'no update available');
      }
      // Reset retry counter on success
      retryIndex = 0;

      void result?.downloadPromise?.catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', 'updater', `download failed: ${msg}`);
        notifyError(msg);
        scheduleRetry();
      });
      return result;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'updater', `check failed: ${msg}`);
      notifyError(msg);
      scheduleRetry();
      return null;
    })
    .finally(() => {
      if (inFlightCheck === p) inFlightCheck = null;
    });

  inFlightCheck = p;
  return p;
}

/** Send error event to renderer so UI can show it. */
function notifyError(message) {
  const win = getMainWindowRef?.();
  if (win?.webContents) {
    win.webContents.send('updater:error', { message });
  }
}

/** Schedule a retry with exponential backoff after a failed check. */
function scheduleRetry() {
  if (retryTimer) return; // already scheduled

  const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
  retryIndex++;

  log('info', 'updater', `retry scheduled in ${delay / 1000}s (attempt ${retryIndex})`);

  retryTimer = setTimeout(() => {
    retryTimer = null;
    checkForUpdatesOnce().catch((err) => {
      log('error', 'updater', `retry failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, delay);
}

/** Start the periodic polling loop. */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    checkForUpdatesOnce().catch((err) => {
      log('error', 'updater', `poll failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, POLL_INTERVAL);
}

// Reference to getMainWindow — set by setupAutoUpdater
let getMainWindowRef = null;

/**
 * Set up auto-updater events and IPC handlers.
 * IPC handlers are always registered so the renderer never gets a
 * "no handler" error. In dev mode they return a friendly message.
 *
 * @param {() => import('electron').BrowserWindow | null} getMainWindow
 */
export function setupAutoUpdater(getMainWindow) {
  getMainWindowRef = getMainWindow;
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

  // IPC: install and restart — silent install, no user interaction needed
  ipcMain.handle('updater:install', () => {
    if (!isPackaged) return;
    log('info', 'updater', 'installing update (silent) and restarting...');
    autoUpdater.quitAndInstall(true, true);
  });

  // IPC: return log file path for diagnostics
  ipcMain.handle('updater:log-path', async () => {
    try {
      const { getLogPath } = await import('./logger.js');
      return getLogPath();
    } catch {
      return null;
    }
  });

  // Only set up autoUpdater events and background polling in packaged builds
  if (!isPackaged) {
    log('info', 'updater', 'dev mode — auto-update disabled, IPC handlers registered');
    return;
  }

  // Notify renderer when a new version is available
  autoUpdater.on('update-available', (info) => {
    log('info', 'updater', `v${info.version} available`);
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
    log('info', 'updater', `v${info.version} downloaded and ready`);
    getMainWindow()?.webContents.send('updater:update-downloaded', {
      version: info.version,
    });
  });

  // Catch autoUpdater errors — log to file AND notify renderer
  autoUpdater.on('error', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'updater', `autoUpdater error: ${msg}`);
    notifyError(msg);
    scheduleRetry();
  });

  // Initial check after startup delay
  setTimeout(() => {
    checkForUpdatesOnce().catch((err) => {
      log('error', 'updater', `initial check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, STARTUP_DELAY);

  // Periodic polling
  startPolling();

  log('info', 'updater', `initialized (v${app.getVersion()}, startup delay ${STARTUP_DELAY / 1000}s, poll every ${POLL_INTERVAL / 60_000}min)`);
}
