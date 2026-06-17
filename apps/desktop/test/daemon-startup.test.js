/**
 * Regression test for: daemon fails to start when system Node.js is not installed.
 *
 * Root cause: startDaemonProduction() used findSystemNode() to find node.exe via
 * where.exe node. On systems without Node.js, the daemon never started.
 *
 * Fix: Use Electron's embedded Node.js via ELECTRON_RUN_AS_NODE=1 and
 * download Electron prebuilt binary for better-sqlite3 via prebuild-install.
 *
 * See: https://github.com/zhuzhaoyun/Molio/issues/21
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mainJs = readFileSync(
  path.resolve(import.meta.dirname, '../src/main.js'),
  'utf-8'
);

const prepareResourcesJs = readFileSync(
  path.resolve(import.meta.dirname, '../scripts/prepare-resources.mjs'),
  'utf-8'
);

describe('main.js: daemon must use Electron embedded Node.js (not system node)', () => {
  it('should NOT have findSystemNode() function', () => {
    assert.ok(
      !mainJs.includes('findSystemNode'),
      'findSystemNode() must be removed — daemon should use Electron embedded Node.js'
    );
  });

  it('should NOT import execFileSync (no longer needed for where.exe)', () => {
    assert.ok(
      !mainJs.includes('execFileSync'),
      'execFileSync must not be imported — where.exe lookup is no longer used'
    );
  });

  it('should spawn daemon with process.execPath', () => {
    assert.ok(
      mainJs.includes('process.execPath'),
      'startDaemonProduction must use process.execPath (Electron binary)'
    );
  });

  it('should set ELECTRON_RUN_AS_NODE=1 environment variable', () => {
    assert.ok(
      mainJs.includes('ELECTRON_RUN_AS_NODE'),
      'startDaemonProduction must set ELECTRON_RUN_AS_NODE=1'
    );
  });

  it('should pass daemonEntry as argument to spawn', () => {
    // spawn(process.execPath, [daemonEntry], ...)
    const spawnCall = mainJs.match(/spawn\(\s*process\.execPath\s*,\s*\[daemonEntry\]/);
    assert.ok(
      spawnCall,
      'spawn must be called with (process.execPath, [daemonEntry], ...)'
    );
  });

  it('should reference daemon.mjs (not daemon.js)', () => {
    assert.ok(
      mainJs.includes("daemon.mjs") || mainJs.includes('daemon.mjs'),
      'daemon entry must be daemon.mjs for ESM parsing by Electron embedded Node.js'
    );
  });
});

describe('main.js: must load URL only after daemon is ready (not in createWindow)', () => {
  it('createWindow should NOT call loadURL for production (localhost:3100)', () => {
    // Extract createWindow function body
    const fnStart = mainJs.indexOf('function createWindow()');
    assert.ok(fnStart !== -1, 'createWindow must exist');

    const fnEnd = mainJs.indexOf('\nfunction ', fnStart + 1);
    const fnBody = mainJs.slice(fnStart, fnEnd);

    assert.ok(
      !fnBody.includes('localhost:3100'),
      'createWindow must NOT call loadURL for localhost:3100 — that causes 404 on slow machines'
    );
  });

  it('createWindow should load splash.html in production mode', () => {
    const fnStart = mainJs.indexOf('function createWindow()');
    const fnEnd = mainJs.indexOf('\nfunction ', fnStart + 1);
    const fnBody = mainJs.slice(fnStart, fnEnd);

    assert.ok(
      fnBody.includes('splash.html'),
      'createWindow must load splash.html while waiting for daemon'
    );
  });

  it('loadApp should call loadURL for localhost:3100', () => {
    assert.ok(
      mainJs.includes('function loadApp()'),
      'loadApp function must exist'
    );

    const fnStart = mainJs.indexOf('function loadApp()');
    const fnEnd = mainJs.indexOf('\nfunction ', fnStart + 1);
    const fnBody = mainJs.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 500);

    assert.ok(
      fnBody.includes('localhost:3100'),
      'loadApp must call loadURL for localhost:3100'
    );
  });

  it('loadApp should be called after startDaemonProduction in whenReady', () => {
    const whenReadyPos = mainJs.indexOf('app.whenReady()');
    assert.ok(whenReadyPos !== -1, 'app.whenReady() must exist');

    const whenReadyBlock = mainJs.slice(whenReadyPos);
    const daemonPos = whenReadyBlock.indexOf('startDaemonProduction');
    const loadAppPos = whenReadyBlock.indexOf('loadApp()');

    assert.ok(daemonPos !== -1, 'startDaemonProduction must be in whenReady block');
    assert.ok(loadAppPos !== -1, 'loadApp() must be in whenReady block');
    assert.ok(
      loadAppPos > daemonPos,
      `loadApp() (pos ${loadAppPos}) must be called AFTER startDaemonProduction (pos ${daemonPos})`
    );
  });
});

describe('main.js: protocol launch should leave splash after daemon is ready', () => {
  it('should parse molio://launch as a protocol target', () => {
    assert.ok(
      mainJs.includes('function parseMolioProtocolUrl'),
      'main.js must centralize molio:// protocol parsing'
    );
    assert.ok(
      mainJs.includes("return { action: 'launch' }"),
      'molio://launch must parse to a launch action'
    );
  });

  it('should detect when the production splash page is still showing', () => {
    assert.ok(
      mainJs.includes('function isShowingSplash()'),
      'main.js must be able to detect the splash page before handling molio://launch'
    );
    assert.ok(
      mainJs.includes('splash.html'),
      'splash detection must check for splash.html'
    );
    assert.ok(
      mainJs.includes('webContents.getURL()'),
      'splash detection must inspect the current BrowserWindow URL'
    );
  });

  it('molio://launch should call loadApp when still on splash', () => {
    const navigatePos = mainJs.indexOf('function navigateFromProtocolUrl');
    assert.ok(navigatePos !== -1, 'navigateFromProtocolUrl must exist');

    const navigateBlock = mainJs.slice(navigatePos, navigatePos + 900);
    assert.ok(
      navigateBlock.includes("target?.action === 'launch'"),
      'navigateFromProtocolUrl must handle parsed launch actions'
    );
    assert.ok(
      navigateBlock.includes('isShowingSplash()'),
      'molio://launch handling must check if the app is still showing splash'
    );
    assert.ok(
      navigateBlock.includes('loadApp()'),
      'molio://launch handling must load the real app when launched from splash'
    );
  });

  it('should support file-only open protocol for single-prompt clip saves', () => {
    assert.ok(
      mainJs.includes('molio://open/file/'),
      'desktop protocol parser must support molio://open/file/<filePath>'
    );
    assert.ok(
      mainJs.includes("params.set('file', target.filePath)"),
      'file-only protocol target must navigate to the knowledge page with a file param'
    );
  });
});

describe('prepare-resources.mjs: better-sqlite3 must use Electron prebuild', () => {
  it('should use prebuild-install to download Electron prebuilt binary', () => {
    assert.ok(
      prepareResourcesJs.includes('prebuild-install'),
      'prepare-resources must use prebuild-install to download Electron prebuilt binary'
    );
  });

  it('should target electron runtime', () => {
    assert.ok(
      prepareResourcesJs.includes("'electron'") || prepareResourcesJs.includes('--runtime electron'),
      'prebuild-install must target electron runtime'
    );
  });

  it('should output daemon.mjs (not daemon.js) for ESM parsing', () => {
    assert.ok(
      prepareResourcesJs.includes('daemon.mjs'),
      'esbuild output must be daemon.mjs for ESM parsing by Electron embedded Node.js'
    );
  });

  it('should use electronVersion from electron/package.json', () => {
    assert.ok(
      prepareResourcesJs.includes('electronVersion'),
      'prebuild must use electronVersion from electron/package.json'
    );
  });

  it('should keep qrcode external and copy its runtime dependencies', () => {
    assert.ok(
      prepareResourcesJs.includes("'qrcode'"),
      'qrcode must stay external so its CommonJS fs requires work in the ESM daemon bundle'
    );
    assert.ok(
      prepareResourcesJs.includes("'dijkstrajs'") && prepareResourcesJs.includes("'pngjs'"),
      'qrcode runtime dependencies must be copied to desktop resources'
    );
  });
});
