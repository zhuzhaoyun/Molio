import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');
const preloadSource = readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf-8');

describe('main.js new-window entry (P2)', () => {
  it('keeps 文件 → 新窗口 as a click-only menu item (no accelerator)', () => {
    const start = mainSource.indexOf('function buildAppMenu(');
    const end = mainSource.indexOf('function openNewWindowAt(');
    const menuSection = mainSource.slice(start, end);
    assert.ok(menuSection.includes('Menu.setApplicationMenu'), 'must set an app menu');
    assert.match(menuSection, /label:\s*['"]新窗口['"]/, 'File menu must keep the New Window item');
    assert.ok(menuSection.includes('openNewWindowFromFocused'), 'New Window item must open via openNewWindowFromFocused');
    assert.ok(
      !menuSection.includes('CmdOrCtrl'),
      'must NOT bind a keyboard accelerator — no bare one-key new-window on any page',
    );
    assert.ok(mainSource.includes('editMenu') && mainSource.includes('windowMenu'), 'standard roles must be kept');
    assert.ok(mainSource.includes("role: 'appMenu'"), 'macOS app menu must be retained');
  });

  it('registers app:new-window IPC creating a window with a url', () => {
    assert.ok(mainSource.includes("ipcMain.handle('app:new-window'"));
    assert.match(mainSource, /createWindow\(\{ url/);
  });

  it('clones the focused window url for a new window', () => {
    assert.ok(mainSource.includes('openNewWindowFromFocused'));
    assert.ok(mainSource.includes('getURL'), 'must read focused window url');
  });
});

describe('preload openNewWindow bridge (P2)', () => {
  it('exposes openNewWindow via app:new-window IPC', () => {
    assert.ok(preloadSource.includes('openNewWindow'));
    assert.ok(preloadSource.includes("invoke('app:new-window'"));
  });
});
