/**
 * @molio/desktop preload script
 * Provides a minimal, safe bridge between the renderer (web app) and the main process.
 * Context isolation is enabled; this script runs in an isolated context.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose a minimal API to the renderer (currently none needed,
// the web app communicates with the daemon via HTTP/SSE.)
contextBridge.exposeInMainWorld('__electron__', {
  platform: process.platform,

  /** Show a directory picker dialog. Returns the selected path or null. */
  showDirectoryPicker: () => ipcRenderer.invoke('show-directory-picker'),
});
