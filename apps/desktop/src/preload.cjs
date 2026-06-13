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
};

// Updater API — event listeners + actions
const updaterAPI = {
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
  getLogPath: () => ipcRenderer.invoke('updater:log-path'),
};

contextBridge.exposeInMainWorld('__electron__', desktopAPI);
contextBridge.exposeInMainWorld('updater', updaterAPI);
