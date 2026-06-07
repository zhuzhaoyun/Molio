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
});
