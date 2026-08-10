/**
 * OS-level "New Window" entries (source-assertion tests, matching the
 * existing main.js test convention — see window-new-window.test.js).
 *
 * macOS: dock menu with 「新窗口」+ 「最近使用的知识库」 submenu (backed by the
 * vault-recency LRU, refreshed from the daemon vault list).
 * Windows: taskbar Jump List task launching `--new-window`, which the
 * single-instance lock forwards to `second-instance` → open a new window.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');

describe('main.js macOS dock menu', () => {
  it('builds the dock menu and sets it via app.dock.setMenu', () => {
    assert.match(mainSource, /app\.dock\.setMenu\(/);
    assert.ok(mainSource.includes('function buildDockMenu('));
  });

  it('dock menu has a New Window item wired to openNewWindowFromFocused', () => {
    assert.match(mainSource, /label:\s*['"]新窗口['"],\s*click:\s*\(\)\s*=>\s*openNewWindowFromFocused\(\)/);
  });

  it('dock menu has a recently-used-vaults submenu', () => {
    assert.ok(mainSource.includes("label: '最近使用的知识库'"));
    assert.ok(mainSource.includes('submenu: vaultItems'));
  });

  it('vault click opens /knowledge?vault=<id> in a new window', () => {
    assert.ok(mainSource.includes('openVaultInNewWindow(v.id)'));
    assert.match(mainSource, /knowledge\?vault=/);
    assert.ok(mainSource.includes('encodeURIComponent(vaultId)'));
  });

  it('fetches the daemon vault list and ranks recent-first', () => {
    assert.match(mainSource, /fetch\(`\$\{DAEMON_BASE\}\/api\/knowledge\/vaults`/);
    assert.ok(mainSource.includes('recent.has(v.id)'), 'must rank recently-opened vaults first');
  });

  it('is macOS-only and throttles rebuilds on window focus', () => {
    assert.match(mainSource, /process\.platform\s*!==\s*['"]darwin['"]\s*\|\|\s*!app\.dock/);
    assert.ok(mainSource.includes("app.on('browser-window-focus', throttleRefreshDockMenu)"));
    assert.ok(mainSource.includes('DOCK_REFRESH_THROTTLE_MS'), 'must throttle focus-refresh');
  });

  it('records vault opens on full loads AND SPA switches → recency.touch', () => {
    assert.ok(mainSource.includes("win.webContents.on('did-navigate', recordVaultNavigation)"));
    assert.ok(mainSource.includes("win.webContents.on('did-navigate-in-page', recordVaultNavigation)"));
    assert.ok(mainSource.includes("searchParams.get('vault')"));
    assert.ok(mainSource.includes('vaultRecency.touch(vaultId)'));
  });
});

describe('main.js Windows taskbar Jump List', () => {
  it('registers a New Window task via app.setUserTasks', () => {
    assert.ok(mainSource.includes('function buildJumpList('));
    assert.match(mainSource, /app\.setUserTasks\(/);
  });

  it('the task relaunches the exe with --new-window and the app icon', () => {
    assert.match(mainSource, /arguments:\s*['"]--new-window['"]/);
    assert.ok(mainSource.includes('iconPath: process.execPath'));
    assert.ok(mainSource.includes('program: process.execPath'));
  });

  it('is Windows-only', () => {
    assert.match(mainSource, /process\.platform\s*!==\s*['"]win32['"]/);
    assert.match(mainSource, /typeof\s+app\.setUserTasks\s*!==\s*['"]function['"]/);
  });

  it('second-instance handles --new-window by opening a new window', () => {
    assert.ok(mainSource.includes("commandLine.includes('--new-window')"));
    // Must return early — open a window, don't just focus the existing one.
    const seg = mainSource.slice(mainSource.indexOf("app.on('second-instance'"), mainSource.indexOf("app.on('second-instance'") + 900);
    assert.ok(seg.includes('openNewWindowFromFocused()'), 'second-instance --new-window must call openNewWindowFromFocused');
  });
});

describe('main.js vault-recency wiring', () => {
  it('persists recency to a JSON file under userData', () => {
    assert.ok(mainSource.includes("vault-recency.json"));
    assert.ok(mainSource.includes("app.getPath('userData')"));
    assert.ok(mainSource.includes('createVaultRecency'));
  });
});
