/**
 * Open a Molio SPA path in a new window.
 *
 * In the Electron shell this opens a new BrowserWindow via the desktop preload
 * bridge (Task 2); in a plain browser (dev / web-only) it falls back to
 * window.open() — a new tab, the browser's equivalent of a new window.
 * WebUI-first: this layer only decides HOW to open; the caller decides WHAT URL.
 */
export function openInNewWindow(path: string): void {
  const electron = window.__electron__;
  if (electron?.openNewWindow) {
    void electron.openNewWindow(path);
  } else {
    window.open(path, '_blank');
  }
}
