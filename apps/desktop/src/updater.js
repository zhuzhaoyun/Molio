/**
 * Auto-update module for Molio desktop.
 *
 * Uses electron-updater to check for updates from GitHub Releases,
 * download them in the background, and notify the renderer when ready.
 *
 * Key design:
 * - Main process owns the updater state; renderer queries/subscribes to it
 * - Downloads are started explicitly after an update is found
 * - Errors are logged to file AND surfaced to the renderer UI
 * - Failed background checks/downloads retry with exponential backoff
 * - Installation avoids electron-updater quitAndInstall() because it races
 *   with Windows file locks held by Electron/daemon processes
 */

import pkg from 'electron-updater';
import { app, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { log, getLogPath } from './logger.js';
import { createRetryState } from './retry.js';

const { autoUpdater } = pkg;

/** Convenience: format any error to a log-safe string. */
const errMsg = (err) => (err?.message || String(err));

// We start downloads ourselves after update-available. Keeping one explicit
// download path avoids relying on electron-updater's implicit autoDownload flow.
autoUpdater.autoDownload = false;
// IMPORTANT: Disabled to prevent electron-updater from spawning the NSIS installer
// before the app has fully exited. The built-in quitAndInstall() has a race condition
// where it spawns the installer via setImmediate while the Electron main process still
// holds file locks on the exe. We handle installation manually in the updater:install
// handler with correct sequencing: kill daemon -> spawn installer -> app.quit().
autoUpdater.autoInstallOnAppQuit = false;

const STARTUP_DELAY = 5_000;          // check 5s after launch
const POLL_INTERVAL = 60 * 60 * 1000; // check every hour

const retry = createRetryState();
let retryTimer = null;
let pollTimer = null;
let inFlightCheck = null;
let inFlightDownload = null;
let installing = false;

// Reference to getMainWindow — set by setupAutoUpdater
let getMainWindowRef = null;

const updaterState = {
  status: 'idle',
  currentVersion: 'unknown',
  latestVersion: null,
  percent: 0,
  downloadedFile: null,
  message: null,
  devMode: false,
};

function publicState() {
  return {
    ok: true,
    status: updaterState.status,
    currentVersion: updaterState.currentVersion,
    latestVersion: updaterState.latestVersion ?? updaterState.currentVersion,
    available: updaterState.status === 'available' ||
      updaterState.status === 'downloading' ||
      updaterState.status === 'downloaded' ||
      updaterState.status === 'installing',
    downloading: updaterState.status === 'downloading',
    downloaded: updaterState.status === 'downloaded' || updaterState.status === 'installing',
    percent: updaterState.percent,
    message: updaterState.message,
    devMode: updaterState.devMode,
  };
}

function setState(patch, { broadcast = true } = {}) {
  Object.assign(updaterState, patch);
  if (broadcast) broadcastState();
}

function getMainWindow() {
  return getMainWindowRef?.() ?? null;
}

function send(channel, payload) {
  const win = getMainWindow();
  if (win?.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function broadcastState() {
  send('updater:state-changed', publicState());
}

function notifyError(message) {
  setState({ status: 'error', message, downloadedFile: null });
  send('updater:error', { message });
}

function scheduleRetry() {
  if (retryTimer) return; // already scheduled
  if (updaterState.status === 'downloaded' || updaterState.status === 'installing') return;

  const delay = retry.next();
  const attempt = retry.attempt;

  log('info', 'updater', `retry scheduled in ${delay / 1000}s (attempt ${attempt})`);

  retryTimer = setTimeout(() => {
    retryTimer = null;
    checkForUpdatesOnce({ background: true }).catch((err) => {
      log('error', 'updater', `retry failed: ${errMsg(err)}`);
    });
  }, delay);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (updaterState.status === 'downloaded' || updaterState.status === 'installing') return;
    checkForUpdatesOnce({ background: true }).catch((err) => {
      log('error', 'updater', `poll failed: ${errMsg(err)}`);
    });
  }, POLL_INTERVAL);
}

function startDownload(cancellationToken) {
  if (inFlightDownload) return inFlightDownload;
  if (updaterState.status === 'downloaded' || updaterState.status === 'installing') {
    return Promise.resolve([]);
  }

  log('info', 'updater', 'starting update download...');
  setState({
    status: 'downloading',
    percent: Math.max(updaterState.percent || 0, 0),
    message: null,
    downloadedFile: null,
  });

  try {
    inFlightDownload = autoUpdater
      .downloadUpdate(cancellationToken)
      .catch((err) => {
        const msg = errMsg(err);
        log('error', 'updater', `download failed: ${msg}`);
        notifyError(msg);
        scheduleRetry();
        return [];
      })
      .finally(() => {
        inFlightDownload = null;
      });
  } catch (err) {
    const msg = errMsg(err);
    log('error', 'updater', `failed to start download: ${msg}`);
    notifyError(msg);
    scheduleRetry();
    inFlightDownload = null;
    return Promise.resolve([]);
  }

  return inFlightDownload;
}

async function checkForUpdatesOnce({ background = false } = {}) {
  if (updaterState.status === 'downloaded' || updaterState.status === 'installing') {
    return publicState();
  }
  if (inFlightCheck) return inFlightCheck;

  log('info', 'updater', 'checking for updates...');
  setState({ status: 'checking', message: null });

  inFlightCheck = autoUpdater
    .checkForUpdates()
    .then((result) => {
      retry.reset();

      if (!result?.isUpdateAvailable) {
        log('info', 'updater', 'no update available');
        setState({
          status: 'up-to-date',
          latestVersion: result?.updateInfo?.version ?? updaterState.currentVersion,
          percent: 0,
          message: null,
          downloadedFile: null,
        });
        return publicState();
      }

      const latestVersion = result.updateInfo?.version ?? updaterState.currentVersion;
      log('info', 'updater', `update available: v${latestVersion}`);
      setState({
        status: 'available',
        latestVersion,
        percent: 0,
        message: null,
        downloadedFile: null,
      });

      void startDownload(result.cancellationToken);
      return publicState();
    })
    .catch((err) => {
      const msg = errMsg(err);
      log('error', 'updater', `check failed: ${msg}`);
      notifyError(msg);
      if (background) scheduleRetry();
      return publicState();
    })
    .finally(() => {
      inFlightCheck = null;
    });

  return inFlightCheck;
}

async function installDownloadedUpdate(killDaemon) {
  if (installing) return publicState();
  if (!updaterState.downloadedFile) {
    const msg = 'No downloaded installer found — cannot install update';
    log('error', 'updater', msg);
    notifyError(msg);
    return publicState();
  }

  installing = true;
  setState({ status: 'installing', message: null });
  log('info', 'updater', 'installing update (manual sequence)...');

  if (killDaemon) {
    log('info', 'updater', 'killing daemon before install...');
    await killDaemon();
  }

  const installerPath = updaterState.downloadedFile;
  log('info', 'updater', `spawning installer: ${installerPath}`);

  // --updated: tells the new installer this is an update (skip some prompts)
  // /S: silent install (no user interaction)
  // --force-run: restart app after install completes
  const args = ['--updated', '/S', '--force-run'];

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (nextState) => {
      if (!resolved) {
        resolved = true;
        resolve(nextState ?? publicState());
      }
    };

    try {
      const installer = spawn(installerPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      installer.unref();

      installer.once('error', (err) => {
        installing = false;
        const msg = errMsg(err);
        log('error', 'updater', `failed to spawn installer: ${msg}`);
        notifyError(msg);
        finish(publicState());
      });

      installer.once('spawn', () => {
        log('info', 'updater', `installer started (pid=${installer.pid}), quitting app...`);
        finish(publicState());
        app.quit();
      });
    } catch (err) {
      installing = false;
      const msg = errMsg(err);
      log('error', 'updater', `failed to spawn installer: ${msg}`);
      notifyError(msg);
      finish(publicState());
    }
  });
}

/**
 * Set up auto-updater events and IPC handlers.
 * IPC handlers are always registered so the renderer never gets a
 * "no handler" error. In dev mode they return a friendly state.
 *
 * @param {() => import('electron').BrowserWindow | null} getMainWindowRefFn
 * @param {() => Promise<void>} [killDaemon] - Kill daemon before install
 *   to release file locks. Without this, the NSIS installer fails with
 *   "Failed to uninstall old application files" because the daemon holds
 *   locks on files in the installation directory.
 */
export function setupAutoUpdater(getMainWindowRefFn, killDaemon) {
  getMainWindowRef = getMainWindowRefFn;
  const isPackaged = app.isPackaged;

  setState({
    currentVersion: app.getVersion(),
    latestVersion: app.getVersion(),
    devMode: !isPackaged,
  }, { broadcast: false });

  ipcMain.handle('updater:get-state', () => publicState());

  ipcMain.handle('updater:check', async () => {
    if (!isPackaged) {
      setState({
        status: 'up-to-date',
        currentVersion: app.getVersion(),
        latestVersion: app.getVersion(),
        devMode: true,
      });
      return publicState();
    }
    return checkForUpdatesOnce({ background: false });
  });

  ipcMain.handle('updater:install', async () => {
    if (!isPackaged) return publicState();
    return installDownloadedUpdate(killDaemon);
  });

  ipcMain.handle('updater:log-path', () => getLogPath());

  if (!isPackaged) {
    log('info', 'updater', 'dev mode — auto-update disabled, IPC handlers registered');
    return;
  }

  autoUpdater.on('update-available', (info) => {
    log('info', 'updater', `v${info.version} available`);
    setState({
      status: updaterState.status === 'downloading' ? 'downloading' : 'available',
      latestVersion: info.version,
      percent: updaterState.status === 'downloading' ? updaterState.percent : 0,
      message: null,
      downloadedFile: null,
    });
    send('updater:update-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(updaterState.percent || 0, progress.percent || 0);
    setState({ status: 'downloading', percent, message: null });
    send('updater:download-progress', { percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = info.version ?? updaterState.latestVersion ?? updaterState.currentVersion;
    setState({
      status: 'downloaded',
      latestVersion: version,
      percent: 100,
      downloadedFile: info.downloadedFile,
      message: null,
    });
    log('info', 'updater', `v${version} downloaded and ready: ${info.downloadedFile}`);
    send('updater:update-downloaded', { version });
  });

  autoUpdater.on('error', (err) => {
    const msg = errMsg(err);
    log('error', 'updater', `autoUpdater error: ${msg}`);
    notifyError(msg);
    scheduleRetry();
  });

  setTimeout(() => {
    checkForUpdatesOnce({ background: true }).catch((err) => {
      log('error', 'updater', `initial check failed: ${errMsg(err)}`);
    });
  }, STARTUP_DELAY);

  startPolling();

  log('info', 'updater', `initialized (v${app.getVersion()}, startup delay ${STARTUP_DELAY / 1000}s, poll every ${POLL_INTERVAL / 60_000}min)`);
}
