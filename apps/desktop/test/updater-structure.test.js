/**
 * Regression tests for updater resilience invariants in main.js.
 *
 * These are STRUCTURAL tests — they read main.js as text and verify that
 * critical code patterns exist. This catches the most common AI-generated
 * regression: reordering initialization so updater starts after daemon,
 * or removing global crash handlers.
 *
 * If any PR changes main.js and breaks these invariants, these tests fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mainJs = readFileSync(
  path.resolve(import.meta.dirname, '../src/main.js'),
  'utf-8'
);

describe('main.js: updater must initialize before daemon', () => {
  it('setupAutoUpdater should be called before startDaemonProduction', () => {
    const updaterPos = mainJs.indexOf('setupAutoUpdater');
    const daemonPos = mainJs.indexOf('startDaemonProduction');

    assert.ok(updaterPos !== -1, 'setupAutoUpdater must be called in main.js');
    assert.ok(daemonPos !== -1, 'startDaemonProduction must exist in main.js');

    // In app.whenReady(), setupAutoUpdater must appear BEFORE startDaemonProduction
    // Find the whenReady block
    const whenReadyPos = mainJs.indexOf('app.whenReady()');
    assert.ok(whenReadyPos !== -1, 'app.whenReady() must exist');

    const whenReadyBlock = mainJs.slice(whenReadyPos);
    const updaterInBlock = whenReadyBlock.indexOf('setupAutoUpdater');
    const daemonInBlock = whenReadyBlock.indexOf('startDaemonProduction');

    assert.ok(updaterInBlock !== -1, 'setupAutoUpdater must be in whenReady block');
    assert.ok(daemonInBlock !== -1, 'startDaemonProduction must be in whenReady block');
    assert.ok(
      updaterInBlock < daemonInBlock,
      `setupAutoUpdater (pos ${updaterInBlock}) must be called BEFORE startDaemonProduction (pos ${daemonInBlock}) in app.whenReady()`
    );
  });

  it('daemon startup failure should be caught (not crash the app)', () => {
    // startDaemonProduction must be wrapped in try/catch
    const whenReadyPos = mainJs.indexOf('app.whenReady()');
    const whenReadyBlock = mainJs.slice(whenReadyPos);

    // Find the try/catch around startDaemonProduction
    const daemonPos = whenReadyBlock.indexOf('startDaemonProduction');
    const beforeDaemon = whenReadyBlock.slice(0, daemonPos);

    // There should be a 'try {' before startDaemonProduction in the whenReady block
    const lastTry = beforeDaemon.lastIndexOf('try');
    assert.ok(lastTry !== -1, 'startDaemonProduction must be wrapped in try/catch');

    // The try should be close to startDaemonProduction (within ~200 chars)
    assert.ok(
      daemonPos - lastTry < 200,
      `try block (pos ${lastTry}) should be near startDaemonProduction (pos ${daemonPos})`
    );
  });
});

describe('main.js: global crash protection must exist', () => {
  it('should have uncaughtException handler', () => {
    assert.ok(
      mainJs.includes("process.on('uncaughtException'") ||
      mainJs.includes('process.on("uncaughtException"'),
      'main.js must have process.on("uncaughtException") handler'
    );
  });

  it('should have unhandledRejection handler', () => {
    assert.ok(
      mainJs.includes("process.on('unhandledRejection'") ||
      mainJs.includes('process.on("unhandledRejection"'),
      'main.js must have process.on("unhandledRejection") handler'
    );
  });

  it('crash handlers should NOT call process.exit', () => {
    // Extract the crash handler blocks
    const handlers = mainJs.match(/process\.on\(['"](uncaughtException|unhandledRejection)['"][\s\S]*?\}\);/g) || [];
    for (const handler of handlers) {
      assert.ok(
        !handler.includes('process.exit'),
        'Crash handlers must NOT call process.exit — the updater must survive crashes'
      );
    }
  });
});

describe('updater.js: quitAndInstall must use silent mode', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../src/updater.js'),
    'utf-8'
  );

  it('quitAndInstall should be called with (true, true) for silent install', () => {
    // Find all quitAndInstall calls
    const calls = updaterJs.match(/quitAndInstall\([^)]*\)/g) || [];
    assert.ok(calls.length > 0, 'quitAndInstall must be called somewhere');

    for (const call of calls) {
      assert.ok(
        call.includes('quitAndInstall(true, true)'),
        `quitAndInstall must use (true, true) for silent install, got: ${call}`
      );
    }
  });
});

describe('updater.js: error event must notify renderer', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../src/updater.js'),
    'utf-8'
  );

  it("autoUpdater 'error' event should send to renderer via updater:error", () => {
    // The error handler must contain both: log AND send to renderer
    assert.ok(
      updaterJs.includes("'error'") || updaterJs.includes('"error"'),
      "autoUpdater.on('error') handler must exist"
    );
    assert.ok(
      updaterJs.includes("'updater:error'") || updaterJs.includes('"updater:error"'),
      "error handler must send 'updater:error' IPC event to renderer"
    );
  });
});

describe('updater.js: must use retry module (not inline delays)', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../src/updater.js'),
    'utf-8'
  );

  it('should import createRetryState from retry.js', () => {
    assert.ok(
      updaterJs.includes("from './retry.js'") || updaterJs.includes('from "./retry.js"'),
      "updater.js must import from './retry.js'"
    );
    assert.ok(
      updaterJs.includes('createRetryState'),
      'updater.js must use createRetryState'
    );
  });

  it('should NOT have inline RETRY_DELAYS array', () => {
    // The old pattern was: const RETRY_DELAYS = [30_000, ...]
    // This should now be in retry.js
    const hasInlineDelays = /const\s+RETRY_DELAYS\s*=\s*\[/.test(updaterJs);
    assert.ok(
      !hasInlineDelays,
      'updater.js should NOT define RETRY_DELAYS inline — it should use retry.js'
    );
  });
});

describe('preload.cjs: must expose onUpdateError', () => {
  const preloadCjs = readFileSync(
    path.resolve(import.meta.dirname, '../src/preload.cjs'),
    'utf-8'
  );

  it('should expose onUpdateError method', () => {
    assert.ok(
      preloadCjs.includes('onUpdateError'),
      'preload.cjs must expose onUpdateError method'
    );
  });

  it("should listen for 'updater:error' IPC event", () => {
    assert.ok(
      preloadCjs.includes("'updater:error'") || preloadCjs.includes('"updater:error"'),
      "preload.cjs must listen for 'updater:error' IPC event"
    );
  });
});
