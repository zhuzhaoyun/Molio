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
  path.resolve(import.meta.dirname, '../../src/main.js'),
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

    // There should be a 'try {' before startDaemonProduction in the whenReady block.
    // Match 'try {' (with brace) to avoid matching the substring 'try' inside
    // unrelated words like 'entry'.
    const lastTry = beforeDaemon.lastIndexOf('try {');
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

describe('updater.js: must NOT use quitAndInstall on Windows path', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
    'utf-8'
  );

  it('should call quitAndInstall() only on non-Windows path', () => {
    // quitAndInstall() is safe on macOS/Linux (install happens AFTER Electron exits).
    // On Windows, the manual NSIS spawn in spawnInstaller() avoids the file-lock race.
    // Verify the call exists AND is guarded by a non-win32 platform check.
    const hasQuitAndInstallCall = /autoUpdater\.quitAndInstall\s*\(/.test(updaterJs);
    assert.ok(
      hasQuitAndInstallCall,
      'updater.js must call autoUpdater.quitAndInstall() for macOS/Linux'
    );

    // Verify the call is NOT reachable on Windows — it must be AFTER a platform check
    const win32CheckPos = updaterJs.indexOf("process.platform === 'win32'");
    const quitAndInstallPos = updaterJs.indexOf('autoUpdater.quitAndInstall(');
    assert.ok(win32CheckPos !== -1, 'must have process.platform check');
    assert.ok(quitAndInstallPos !== -1, 'must call quitAndInstall');
    assert.ok(
      quitAndInstallPos > win32CheckPos,
      'quitAndInstall() call must appear AFTER the win32 platform check (i.e., in the non-Windows branch)'
    );
  });

  it('should have spawnInstaller for Windows path', () => {
    assert.ok(
      updaterJs.includes('function spawnInstaller'),
      'updater.js must extract Windows NSIS logic into spawnInstaller()'
    );
    assert.ok(
      updaterJs.includes("'--updated'") && updaterJs.includes("'/S'") && updaterJs.includes("'--force-run'"),
      'spawnInstaller must use NSIS-specific flags'
    );
  });

  it('should set autoInstallOnAppQuit to false', () => {
    assert.ok(
      updaterJs.includes('autoInstallOnAppQuit = false'),
      'autoInstallOnAppQuit must be false to prevent uncontrolled install on quit'
    );
  });

  it('should spawn installer manually with detached:true', () => {
    assert.ok(
      updaterJs.includes('detached: true') || updaterJs.includes('detached:true'),
      'installer must be spawned with detached:true so it survives app.quit()'
    );
  });

  it('should listen for installer spawn event and call app.quit() in callback', () => {
    // app.quit() must be inside the 'spawn' event callback to prevent
    // quitting before the installer is confirmed started.
    // We search for the actual code line, not the comments.
    // Comments also contain "app.quit()", so we look for the code pattern
    // where it appears on its own line with whitespace (not in a comment).

    // Verify the spawn event listener exists
    assert.ok(
      updaterJs.includes("installer.once('spawn'") || updaterJs.includes("installer.on('spawn'"),
      "handler must listen for installer 'spawn' event"
    );

    // Verify app.quit() is called on a non-comment line (inside the callback)
    const appQuitLines = updaterJs.split('\n').filter(line =>
      /\s+app\.quit\(\)/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')
    );
    assert.ok(
      appQuitLines.length > 0,
      'handler must call app.quit() in actual code (not just comments)'
    );
  });
});

describe('updater.js: must kill daemon before spawning installer', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
    'utf-8'
  );
  const mainJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/main.js'),
    'utf-8'
  );

  it('setupAutoUpdater should accept a killDaemon parameter', () => {
    // The function signature must include killDaemon
    assert.ok(
      /setupAutoUpdater\s*\([^)]*killDaemon/.test(updaterJs),
      'setupAutoUpdater must accept killDaemon as second parameter'
    );
  });

  it('updater:install handler must call killDaemon before spawning installer', () => {
    // Extract the install helper block. The IPC handler delegates to this
    // helper so the sequencing stays testable without coupling to IPC shape.
    const installStart = updaterJs.indexOf('function installDownloadedUpdate');
    assert.ok(installStart !== -1, 'installDownloadedUpdate helper must exist');

    // Get enough chars to capture the full handler
    const handlerBlock = updaterJs.slice(installStart, installStart + 3500);

    const killPos = handlerBlock.indexOf('killDaemon');
    const spawnPos = handlerBlock.indexOf('spawn(');

    assert.ok(killPos !== -1, 'updater:install must call killDaemon');
    assert.ok(spawnPos !== -1, 'updater:install must spawn installer');
    assert.ok(
      killPos < spawnPos,
      `killDaemon (pos ${killPos}) must be called BEFORE spawn (pos ${spawnPos})`
    );
  });

  it('main.js should pass killDaemon to setupAutoUpdater', () => {
    assert.ok(
      mainJs.includes('setupAutoUpdater(') && mainJs.includes('killDaemon'),
      'main.js must pass killDaemon function to setupAutoUpdater'
    );
  });

  it('main.js killDaemon should use taskkill on Windows', () => {
    // taskkill /F /T is more reliable than proc.kill('SIGKILL') on Windows
    // for killing the entire process tree and releasing file handles.
    assert.ok(
      mainJs.includes('taskkill'),
      "main.js killDaemon must use taskkill for reliable Windows process termination"
    );
  });

  it('main.js killDaemon should guard against double resolve', () => {
    assert.ok(
      mainJs.includes('let resolved'),
      'killDaemon must use a resolved flag to prevent double-resolve'
    );
  });

  it('main.js before-quit should use killDaemon (not raw SIGKILL)', () => {
    const beforeQuitPos = mainJs.indexOf("app.on('before-quit'");
    assert.ok(beforeQuitPos !== -1, 'before-quit handler must exist');

    // Get the before-quit handler block (~1000 chars to cover the entire
    // handler, incl. the metrics/auth-status poller cleanup lines added in M4)
    const handlerBlock = mainJs.slice(beforeQuitPos, beforeQuitPos + 1000);

    assert.ok(
      handlerBlock.includes('killDaemon'),
      'before-quit must call killDaemon() for proper daemon cleanup'
    );
    assert.ok(
      handlerBlock.includes('event.preventDefault()'),
      'before-quit must prevent default to wait for daemon cleanup before quitting'
    );
    assert.ok(
      handlerBlock.includes('stopCryptoServer'),
      'before-quit must stop crypto-server on quit (after daemon exit — daemon may still write tokens during graceful shutdown)'
    );
  });
});

describe('updater.js: error event must notify renderer', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
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

describe('updater.js: update checks must actively start downloads', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
    'utf-8'
  );

  it('should disable autoDownload and use an explicit download path', () => {
    assert.ok(
      updaterJs.includes('autoDownload = false'),
      'autoDownload must be disabled so downloads start through the controller'
    );
  });

  it('should explicitly call downloadUpdate when an update is available', () => {
    assert.ok(
      updaterJs.includes('startDownload'),
      'updater.js must have an explicit download starter'
    );
    assert.ok(
      /autoUpdater\s*\.\s*downloadUpdate/.test(updaterJs),
      'updater.js must actively call autoUpdater.downloadUpdate() after finding an update'
    );
  });
});

describe('updater.js: must expose queryable updater state', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
    'utf-8'
  );
  const preloadCjs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/preload.cjs'),
    'utf-8'
  );

  it('should register updater:get-state IPC handler', () => {
    assert.ok(
      updaterJs.includes("'updater:get-state'") || updaterJs.includes('"updater:get-state"'),
      'updater.js must expose updater:get-state so renderer can recover missed events'
    );
  });

  it('should broadcast updater:state-changed events', () => {
    assert.ok(
      updaterJs.includes("'updater:state-changed'") || updaterJs.includes('"updater:state-changed"'),
      'updater.js must broadcast updater:state-changed'
    );
  });

  it('preload should expose getState and onStateChanged', () => {
    assert.ok(preloadCjs.includes('getState'), 'preload.cjs must expose getState');
    assert.ok(preloadCjs.includes('onStateChanged'), 'preload.cjs must expose onStateChanged');
  });
});

describe('updater.js: install must use public downloaded event data', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
    'utf-8'
  );

  it('should not depend on downloadedUpdateHelper internals', () => {
    assert.ok(
      !updaterJs.includes('downloadedUpdateHelper'),
      'updater.js should use update-downloaded.downloadedFile instead of electron-updater internals'
    );
  });

  it('should store downloadedFile from update-downloaded event', () => {
    const downloadedHandler = updaterJs.match(
      /autoUpdater\.on\('update-downloaded'[\s\S]*?\}\);/
    );
    assert.ok(downloadedHandler, 'update-downloaded handler must exist');
    assert.ok(
      downloadedHandler[0].includes('downloadedFile'),
      'update-downloaded handler must store downloadedFile'
    );
  });

  it('should handle installer spawn errors', () => {
    assert.ok(
      updaterJs.includes("installer.once('error'") || updaterJs.includes("installer.on('error'"),
      'installer spawn errors must be handled and surfaced'
    );
  });
});

describe('updater.js: must use retry module (not inline delays)', () => {
  const updaterJs = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
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
    path.resolve(import.meta.dirname, '../../src/preload.cjs'),
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

describe('release.yml: must promote all three platform manifests to OSS root', () => {
  const releaseYml = readFileSync(
    path.resolve(import.meta.dirname, '../../../../.github/workflows/release.yml'),
    'utf-8'
  );

  it('should loop over all three manifests', () => {
    assert.ok(
      releaseYml.includes('latest.yml') && releaseYml.includes('latest-mac.yml') && releaseYml.includes('latest-linux.yml'),
      'release.yml must reference latest.yml, latest-mac.yml, and latest-linux.yml'
    );
    assert.ok(
      releaseYml.includes('latest-mac.yml') && releaseYml.includes('latest-linux.yml'),
      'release.yml must promote latest-mac.yml and latest-linux.yml (not just latest.yml)'
    );
  });

  it('should use || continue for graceful skip', () => {
    assert.ok(
      releaseYml.includes('|| continue'),
      'release.yml manifest loop must use || continue to skip unbuilt platforms'
    );
  });

  it('should apply sed path prefix to all manifests', () => {
    // The sed command must exist inside the manifest loop
    assert.ok(
      releaseYml.includes('s|url: |url: ${TAG}/|g'),
      'release.yml must have sed path prefix for url field'
    );
    assert.ok(
      releaseYml.includes('s|path: |path: ${TAG}/|g'),
      'release.yml must have sed path prefix for path field'
    );
  });
});
