/**
 * Tests for the platform-specific install dispatch logic in updater.js.
 *
 * These are STRUCTURAL tests — they read updater.js as text and verify
 * the platform branching and spawnInstaller extraction are correct.
 * This catches regressions where someone accidentally:
 * - calls quitAndInstall() on Windows (file-lock race)
 * - calls spawn(DMG) on macOS (DMG is not executable)
 * - removes the platform check
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const updaterJs = readFileSync(
  path.resolve(import.meta.dirname, '../../src/updater.js'),
  'utf-8'
);

// ── Platform dispatch structure ────────────────────────────────

describe('installDownloadedUpdate: must dispatch by platform', () => {
  it('should check process.platform for win32', () => {
    assert.ok(
      updaterJs.includes("process.platform === 'win32'") ||
        updaterJs.includes('process.platform === "win32"'),
      'installDownloadedUpdate must branch on process.platform === "win32"'
    );
  });

  it('should call killDaemon on ALL platforms (before platform branch)', () => {
    const fnStart = updaterJs.indexOf('async function installDownloadedUpdate');
    assert.ok(fnStart !== -1, 'installDownloadedUpdate function must exist');

    const win32CheckPos = updaterJs.indexOf('win32', fnStart);
    const killDaemonCallPos = updaterJs.indexOf('await killDaemon()', fnStart);

    assert.ok(killDaemonCallPos !== -1, 'must call await killDaemon()');
    assert.ok(
      killDaemonCallPos < win32CheckPos,
      'killDaemon must be called BEFORE the win32 platform check (all platforms)'
    );
  });
});

// ── Windows path: spawnInstaller ────────────────────────────────

describe('spawnInstaller: Windows NSIS path', () => {
  it('should be defined as a separate function', () => {
    assert.ok(
      updaterJs.includes('function spawnInstaller('),
      'spawnInstaller must be extracted as a standalone function'
    );
  });

  it('should use NSIS-specific flags', () => {
    assert.ok(
      updaterJs.includes("'--updated'") || updaterJs.includes('"--updated"'),
      'spawnInstaller must pass --updated flag'
    );
    assert.ok(
      updaterJs.includes("'/S'") || updaterJs.includes('"/S"'),
      'spawnInstaller must pass /S flag (silent install)'
    );
    assert.ok(
      updaterJs.includes("'--force-run'") || updaterJs.includes('"--force-run"'),
      'spawnInstaller must pass --force-run flag'
    );
  });

  it('should spawn with detached:true', () => {
    assert.ok(
      updaterJs.includes('detached: true') || updaterJs.includes('detached:true'),
      'installer must be spawned with detached:true'
    );
  });

  it('should call app.quit() after spawn is confirmed', () => {
    const appQuitLines = updaterJs.split('\n').filter(line =>
      /\s+app\.quit\(\)/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')
    );
    assert.ok(
      appQuitLines.length > 0,
      'spawnInstaller must call app.quit() in code (not just comments)'
    );
  });

  it('should handle spawn errors', () => {
    assert.ok(
      updaterJs.includes("installer.once('error'") || updaterJs.includes("installer.on('error'"),
      'spawnInstaller must handle spawn errors'
    );
  });

  it('should NOT call quitAndInstall in the Windows path', () => {
    const win32Pos = updaterJs.indexOf("process.platform === 'win32'");
    const quitAndInstallPos = updaterJs.indexOf('autoUpdater.quitAndInstall(');
    assert.ok(
      quitAndInstallPos > win32Pos,
      'quitAndInstall() must appear AFTER the win32 check (macOS/Linux branch only)'
    );
  });
});

// ── macOS path: spawnMacOSUpdater ─────────────────────────────────

describe('macOS path: spawnMacOSUpdater', () => {
  it('should be defined as a separate function', () => {
    assert.ok(
      updaterJs.includes('function spawnMacOSUpdater('),
      'spawnMacOSUpdater must be extracted as a standalone function'
    );
  });

  it('should write a shell script to tmpdir', () => {
    assert.ok(
      updaterJs.includes("join(tmpdir(), 'molio-update.sh')"),
      'shell script must be written to tmpdir'
    );
  });

  it('should extract ZIP with unzip', () => {
    assert.ok(
      updaterJs.includes('unzip -qo'),
      'must unzip the update ZIP'
    );
  });

  it('should remove quarantine xattr', () => {
    assert.ok(
      updaterJs.includes('xattr -rd com.apple.quarantine'),
      'must remove quarantine xattr from new .app'
    );
  });

  it('should open the new app', () => {
    assert.ok(
      updaterJs.includes('open "$2"'),
      'must launch new app with open command'
    );
  });

  it('should get app bundle path from app.getPath', () => {
    assert.ok(
      updaterJs.includes("dirname(dirname(dirname(app.getPath('exe')))"),
      'must derive .app bundle path from exe path'
    );
  });

  it('should spawn bash script with detached:true', () => {
    assert.ok(
      updaterJs.includes('detached: true') || updaterJs.includes('detached:true'),
      'bash script must be spawned with detached:true'
    );
  });

  it('should call app.quit() after spawn', () => {
    const spawnFuncStart = updaterJs.indexOf('function spawnMacOSUpdater');
    const appQuitPos = updaterJs.indexOf('app.quit()', spawnFuncStart);
    assert.ok(
      appQuitPos > spawnFuncStart,
      'app.quit() must be called inside spawnMacOSUpdater'
    );
  });
});

// ── Linux path: quitAndInstall ────────────────────────────────────

describe('Linux path: quitAndInstall delegation', () => {
  it('should call autoUpdater.quitAndInstall for non-darwin', () => {
    assert.ok(
      /autoUpdater\.quitAndInstall\s*\(/.test(updaterJs),
      'Linux path must call autoUpdater.quitAndInstall()'
    );
  });

  it('should pass silent and force-run arguments', () => {
    assert.ok(
      updaterJs.includes('quitAndInstall(true, true)'),
      'quitAndInstall must be called with (true, true)'
    );
  });

  it('should NOT call quitAndInstall on darwin', () => {
    const darwinPos = updaterJs.indexOf("process.platform === 'darwin'");
    const quitAndInstallPos = updaterJs.indexOf('autoUpdater.quitAndInstall(');
    assert.ok(
      quitAndInstallPos > darwinPos,
      'quitAndInstall() must appear AFTER the darwin check (Linux branch only)'
    );
  });
});

// ── installDownloadedUpdate guards (unchanged from existing) ────

describe('installDownloadedUpdate: guard checks preserved', () => {
  it('should check installing flag to prevent double install', () => {
    assert.ok(
      updaterJs.includes('if (installing) return'),
      'must guard against double install with installing flag'
    );
  });

  it('should check downloadedFile exists', () => {
    assert.ok(
      updaterJs.includes('!updaterState.downloadedFile'),
      'must check downloadedFile exists before installing'
    );
  });
});
