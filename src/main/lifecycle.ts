import { app, BrowserWindow } from 'electron';

/**
 * Enforce single instance using Electron's built-in lock.
 * Returns true if this is the primary instance, false if another is running.
 */
export function enforceSingleton(): boolean {
  const gotLock = app.requestSingleInstanceLock();

  if (!gotLock) {
    // Another instance is already running, quit
    app.quit();
    return false;
  }

  // When a second instance tries to start, focus the existing window
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  return true;
}
