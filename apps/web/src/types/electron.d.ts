/**
 * TypeScript declarations for Electron APIs exposed via preload.
 *
 * These types describe the globals injected by @kge/desktop's preload script.
 * In a plain browser (dev mode), these globals are absent — components must
 * guard with `if (!window.updater) ...` / `if (!window.__electron__) ...`.
 */

interface UpdaterAPI {
  onUpdateAvailable: (callback: (info: { version: string }) => void) => () => void;
  onDownloadProgress: (callback: (progress: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  installUpdate: () => Promise<void>;
  checkForUpdates: () => Promise<
    | { ok: true; currentVersion: string; latestVersion: string; available: boolean }
    | { ok: false; error: string }
  >;
}

interface DesktopAPI {
  platform: string;
  appInfo: { version: string; os: string };
}

declare global {
  interface Window {
    updater?: UpdaterAPI;
    __electron__?: DesktopAPI;
  }
}

export {};
