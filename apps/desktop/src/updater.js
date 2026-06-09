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
import { spawn } from 'node:child_process';
import { log, getLogPath } from './logger.js';
import { createRetryState } from './retry.js';

const { autoUpdater } = pkg;

/** Convenience: format any error to a log-safe string. */
const errMsg = (err) => (errMsg(err));

// Silent background update: download automatically, notify only when ready
autoUpdater.autoDownload = true;
// IMPORTANT: Disabled to prevent electron-updater from spawning the NSIS installer
// before the app has fully exited. The built-in quitAndInstall() has a race condition
// where it spawns the installer via setImmediate while the Electron main process still
// holds file locks on the exe. We handle installation manually in the updater:install
// handler with correct sequencing: kill daemon → spawn installer → app.quit().
autoUpdater.autoInstallOnAppQuit = false;

const STARTUP_DELAY = 5_000;         // check 5s after launch
const POLL_INTERVAL = 60 * 60 * 1000; // check every hour

// Deduplicate concurrent check requests
let inFlightCheck = null;
const retry = createRetryState();
let retryTimer = null;
let pollTimer = null;

// Track downloaded version so IPC can report "ready to install" immediately
let downloadedVersion = null;

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
      retry.reset();

      void result?.downloadPromise?.catch((err) => {
        const msg = errMsg(err);
        log('error', 'updater', `download failed: ${msg}`);
        // Clear stale downloadedVersion so UI doesn't show "ready to install"
        // for a version whose download actually failed.
        downloadedVersion = null;
        notifyError(msg);
        scheduleRetry();
      });
      return result;
    })
    .catch((err) => {
      const msg = errMsg(err);
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

  const delay = retry.next();
  const attempt = retry.attempt;

  log('info', 'updater', `retry scheduled in ${delay / 1000}s (attempt ${attempt})`);

  retryTimer = setTimeout(() => {
    retryTimer = null;
    checkForUpdatesOnce().catch((err) => {
      log('error', 'updater', `retry failed: ${errMsg(err)}`);
    });
  }, delay);
}

/** Start the periodic polling loop. */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    checkForUpdatesOnce().catch((err) => {
      log('error', 'updater', `poll failed: ${errMsg(err)}`);
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
 * @param {() => Promise<void>} [killDaemon] - Kill daemon before install
 *   to release file locks. Without this, the NSIS installer fails with
 *   "Failed to uninstall old application files" because the daemon holds
 *   locks on files in the installation directory.
 */
export function setupAutoUpdater(getMainWindow, killDaemon) {
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
      const latestVersion = result?.updateInfo?.version ?? currentVersion;
      return {
        ok: true,
        currentVersion,
        latestVersion,
        available: result?.isUpdateAvailable ?? false,
        downloaded: downloadedVersion === latestVersion,
        downloadedVersion,
      };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });

  // IPC: install and restart — silent install, no user interaction needed
  //
  // IMPORTANT: We do NOT use quitAndInstall from electron-updater because it has a
  // race condition on Windows: it spawns the NSIS installer BEFORE calling
  // app.quit(), so the Electron main process still holds file locks on the
  // exe when the installer tries to replace it → "Failed to uninstall old
  // application files".
  //
  // Instead we manually control the sequence:
  //   1. Kill daemon (release its file locks)
  //   2. Spawn NSIS installer (detached, so it survives our exit)
  //   3. app.quit() (release Electron's own file locks on the exe)
  ipcMain.handle('updater:install', async () => {
    if (!isPackaged) return;
    log('info', 'updater', 'installing update (manual sequence)...');

    // Step 1: Kill daemon to release file locks in the installation directory
    if (killDaemon) {
      log('info', 'updater', 'killing daemon before install...');
      await killDaemon();
    }

    // Step 2: Get the downloaded installer path from electron-updater internals
    const installerPath = autoUpdater.downloadedUpdateHelper?.file;
    if (!installerPath) {
      const msg = 'No downloaded installer found — cannot install update';
      log('error', 'updater', msg);
      notifyError(msg);
      return;
    }

    log('info', 'updater', `spawning installer: ${installerPath}`);

    // Build NSIS args matching electron-updater's NsisUpdater.doInstall()
    // --updated: tells the new installer this is an update (skip some prompts)
    // /S: silent install (no user interaction)
    // --force-run: restart app after install completes
    const args = ['--updated', '/S', '--force-run'];

    try {
      // Spawn installer detached so it survives after we quit
      const installer = spawn(installerPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      installer.unref();

      // Wait for the installer to actually start before quitting.
      // Without this, app.quit() may release file locks before the
      // installer has a chance to begin, causing a race with Windows
      // cleanup on the installation directory.
      installer.on('spawn', () => {
        log('info', 'updater', `installer started (pid=${installer.pid}), quitting app...`);
        app.quit();
      });
    } catch (err) {
      const msg = errMsg(err);
      log('error', 'updater', `failed to spawn installer: ${msg}`);
      notifyError(msg);
    }
  });

  // IPC: return log file path for diagnostics
  ipcMain.handle('updater:log-path', () => getLogPath());

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
    downloadedVersion = info.version;
    log('info', 'updater', `v${info.version} downloaded and ready`);
    getMainWindow()?.webContents.send('updater:update-downloaded', {
      version: info.version,
    });
  });

  // Catch autoUpdater errors — log to file AND notify renderer
  autoUpdater.on('error', (err) => {
    const msg = errMsg(err);
    log('error', 'updater', `autoUpdater error: ${msg}`);
    notifyError(msg);
    scheduleRetry();
  });

  // Initial check after startup delay
  setTimeout(() => {
    checkForUpdatesOnce().catch((err) => {
      log('error', 'updater', `initial check failed: ${errMsg(err)}`);
    });
  }, STARTUP_DELAY);

  // Periodic polling
  startPolling();

  log('info', 'updater', `initialized (v${app.getVersion()}, startup delay ${STARTUP_DELAY / 1000}s, poll every ${POLL_INTERVAL / 60_000}min)`);
}
