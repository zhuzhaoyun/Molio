/**
 * @kge/desktop preload script
 * Provides a minimal, safe bridge between the renderer (web app) and the main process.
 * Context isolation is enabled; this script runs in an isolated context.
 */

import { contextBridge } from 'electron';

// Expose a minimal API to the renderer (currently none needed;
// the web app communicates with the daemon via HTTP/SSE.)
contextBridge.exposeInMainWorld('__electron__', {
  platform: process.platform,
});
