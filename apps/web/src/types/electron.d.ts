/**
 * TypeScript declarations for Electron APIs exposed via preload.
 *
 * These types describe the globals injected by @molio/desktop's preload script.
 * In a plain browser (dev mode), these globals are absent — components must
 * guard with `if (!window.updater) ...` / `if (!window.__electron__) ...`.
 */

interface UpdaterAPI {
  onStateChanged: (callback: (state: UpdaterState) => void) => () => void;
  onUpdateAvailable: (callback: (info: { version: string }) => void) => () => void;
  onDownloadProgress: (callback: (progress: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  onUpdateError: (callback: (info: { message: string }) => void) => () => void;
  installUpdate: () => Promise<UpdaterState>;
  checkForUpdates: () => Promise<UpdaterState>;
  getState: () => Promise<UpdaterState>;
  getLogPath: () => Promise<string | null>;
}

interface DesktopAPI {
  platform: string;
  appInfo: { version: string; os: string };
  showDirectoryPicker: () => Promise<string | null>;
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => Promise<void>;
  renameFile: (oldPath: string, newPath: string) => Promise<string>;
}

declare global {
  type UpdaterStatus =
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';

  interface UpdaterState {
    ok: true;
    status: UpdaterStatus;
    currentVersion: string;
    latestVersion: string;
    available: boolean;
    downloading: boolean;
    downloaded: boolean;
    percent: number;
    message: string | null;
    devMode: boolean;
  }

  interface Window {
    updater?: UpdaterAPI;
    __electron__?: DesktopAPI;
  }
}

export {};
