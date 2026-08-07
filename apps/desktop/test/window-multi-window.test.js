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
    // Dev base is the Vite server, prod base is the daemon server; both append
    // the url param. The ['"`]? allows the closing quote of the string literal
    // base (e.g. `'http://localhost:5173' + url`).
    assert.match(mainSource, /localhost:5173['"`]?\s*\+\s*url/);
    assert.match(mainSource, /localhost:3100['"`]?\s*\+\s*url/);
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
  it('tracks renderer readiness per webContents in a Map', () => {
    assert.match(mainSource, /rendererStates\s*=\s*new Map/);
  });

  it('routes molio:renderer-ready via event.sender', () => {
    assert.ok(
      mainSource.includes("ipcMain.on('molio:renderer-ready', (event)") &&
        mainSource.includes('event.sender'),
      'renderer-ready must resolve the sending webContents from event.sender',
    );
  });

  it('resets renderer state on did-start-loading per window', () => {
    assert.match(mainSource, /did-start-loading[\s\S]*?rendererStates\.delete/);
  });

  it('deliverNavigation and isWaitingForApp take a target window', () => {
    assert.match(mainSource, /function deliverNavigation\(win, target\)/);
    assert.match(mainSource, /function isWaitingForApp\(win\)/);
  });
});
