/**
 * @molio/desktop preload script
 * Provides a bridge between the renderer (web app) and the main process.
 * Context isolation is enabled; this script runs in an isolated context.
 *
 * NOTE: Electron preload scripts must be CommonJS, not ESM.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Synchronous app info (version, OS)
function fetchAppInfo() {
  try {
    return ipcRenderer.sendSync('app:get-info');
  } catch {
    return { version: 'unknown', os: 'unknown' };
  }
}

// Desktop API — static platform + app info + directory picker
const desktopAPI = {
  platform: process.platform,
  appInfo: fetchAppInfo(),

  /** Show a directory picker dialog. Returns the selected path or null. */
  showDirectoryPicker: () => ipcRenderer.invoke('show-directory-picker'),

  /** Open a file with the system default application. */
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),

  /** Reveal a file or folder in the system's file manager (Explorer/Finder). */
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),

  /** Rename a local file (oldPath -> newPath). */
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),

  /** Relaunch the app (used by the daemon-error page). */
  restartApp: () => ipcRenderer.invoke('app:restart'),

  /**
   * Open a visible BrowserWindow that shares the `feishu` session partition
   * with the hidden wiki-fetcher window, so the user can log into a Feishu
   * tenant (e.g. https://geekbang.feishu.cn). Cookies persist to disk and
   * subsequent fetches by wiki-fetcher will carry them automatically.
   * Optional targetUrl switches to a specific tenant domain.
   */
  openFeishuLogin: (targetUrl) => ipcRenderer.invoke('molio:open-feishu-login', targetUrl),

  /**
   * Read the Feishu login state from the shared `feishu` session partition
   * (cookie-based, survives restarts). Returns { loggedIn, tenants }.
   */
  getFeishuLoginStatus: () => ipcRenderer.invoke('molio:get-feishu-login-status'),

  /**
   * Subscribe to in-page navigation requests from the main process
   * (triggered by molio://open/... when the app is already running).
   * Avoids a full reload — the SPA routes to the file via React Router.
   * Returns an unsubscribe function.
   */
  onNavigate: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('molio:navigate', handler);
    return () => ipcRenderer.removeListener('molio:navigate', handler);
  },

  /**
   * Tell the main process the renderer has mounted and registered its
   * molio:navigate listener. Main uses this to flush any navigation that was
   * queued during cold start (before this listener existed), so a
   * molio://open/... fired right after launch still opens the target file.
   */
  notifyReady: () => ipcRenderer.send('molio:renderer-ready'),

  /**
   * Open a new Electron window loading the given SPA path (e.g. "/knowledge?vault=abc").
   * Used by the web layer's "在新窗口打开" action; in a plain browser the web
   * layer falls back to window.open().
   */
  openNewWindow: (url) => ipcRenderer.invoke('app:new-window', { url }),
};

// Updater API — event listeners + actions
const updaterAPI = {
  onStateChanged: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('updater:state-changed', handler);
    return () => ipcRenderer.removeListener('updater:state-changed', handler);
  },
  onUpdateAvailable: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on('updater:update-available', handler);
    return () => ipcRenderer.removeListener('updater:update-available', handler);
  },
  onDownloadProgress: (callback) => {
    const handler = (_, progress) => callback(progress);
    ipcRenderer.on('updater:download-progress', handler);
    return () => ipcRenderer.removeListener('updater:download-progress', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on('updater:update-downloaded', handler);
    return () => ipcRenderer.removeListener('updater:update-downloaded', handler);
  },
  onUpdateError: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on('updater:error', handler);
    return () => ipcRenderer.removeListener('updater:error', handler);
  },
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  getState: () => ipcRenderer.invoke('updater:get-state'),
  getLogPath: () => ipcRenderer.invoke('updater:log-path'),
};

contextBridge.exposeInMainWorld('__electron__', desktopAPI);
contextBridge.exposeInMainWorld('updater', updaterAPI);
