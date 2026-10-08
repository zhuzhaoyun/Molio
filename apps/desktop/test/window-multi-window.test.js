import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');

describe('main.js multi-window (P2) — window collection', () => {
  it('replaces the single mainWindow global with an appWindows Set', () => {
    assert.ok(
      !/\blet mainWindow = null\b/.test(mainSource) && /\bconst appWindows = new Set\(\)/.test(mainSource),
      'single mainWindow global must be replaced by appWindows Set',
    );
  });

  it('createWindow accepts a url param and loads it in dev and prod', () => {
    assert.match(mainSource, /function createWindow\(\{ url/);
    // Dev base is the Vite server (string literal), prod base is the daemon
    // server (DAEMON_BASE constant, single source for the :3100 port); both
    // append the url param.
    assert.match(mainSource, /localhost:5173['"`]?\s*\+\s*url/);
    assert.match(mainSource, /DAEMON_BASE\s*\+\s*url/);
  });

  it('tracks and clears the last focused app window', () => {
    assert.match(mainSource, /lastFocusedAppWindow/);
    assert.match(mainSource, /appWindows\.delete\(win\)/);
  });

  it('updater and window-all-closed survive multi-window', () => {
    assert.ok(mainSource.includes("ipcMain.handle('app:restart'"), 'restart IPC untouched');
    assert.match(mainSource, /window-all-closed/);
  });
});

describe('main.js multi-window (P2) — per-webContents renderer state', () => {
  it('tracks renderer readiness per webContents', () => {
    // Extracted into renderer-readiness.js (keyed by webContents id) — see
    // clip-open-navigation.test.js for why the clearing rules matter.
    assert.match(mainSource, /const rendererStates = createRendererReadiness\(\)/);
    assert.match(mainSource, /rendererStates\.\w+\(wcId\)/, 'per-window state must be keyed by the captured webContents id');
  });

  it('routes molio:renderer-ready via event.sender', () => {
    assert.ok(
      mainSource.includes("ipcMain.on('molio:renderer-ready', (event)") &&
        mainSource.includes('event.sender'),
      'renderer-ready must resolve the sending webContents from event.sender',
    );
  });

  it('resets renderer state per window when the document is replaced', () => {
    // Not `did-start-loading`: that fires for same-document SPA navigation too,
    // and clearing readiness there made every later clip reload the window and
    // kill the in-flight reply (clip-open-navigation.test.js pins that).
    assert.match(mainSource, /did-start-navigation[\s\S]*?rendererStates\.onNavigationStarted\(wcId/);
  });

  it('deliverNavigation and isWaitingForApp take a target window', () => {
    assert.match(mainSource, /function deliverNavigation\(win, target\)/);
    assert.match(mainSource, /function isWaitingForApp\(win\)/);
  });
});
