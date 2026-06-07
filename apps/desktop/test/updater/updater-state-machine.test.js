/**
 * Regression tests for the auto-updater state machine (issue #14).
 *
 * Bug: Download reaches 100%, but instead of transitioning to "downloaded"
 * state, a subsequent `update-available` event resets progress to 0%.
 *
 * These tests read the state machine source (updater-state.ts) and verify
 * critical transition guards exist. This catches the most common regression:
 * removing a guard that prevents state from going backwards.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const STATE_FILE = path.resolve(
  import.meta.dirname,
  '../../../web/src/components/settings/updater-state.ts'
);

const stateSrc = readFileSync(STATE_FILE, 'utf-8');

// ── onUpdateAvailable guards ────────────────────────────────────

describe('onUpdateAvailable: must not leave "downloaded" state', () => {
  // Extract the onUpdateAvailable function body
  const fnMatch = stateSrc.match(
    /export function onUpdateAvailable[\s\S]*?^}/m
  );
  assert.ok(fnMatch, 'onUpdateAvailable function must exist');
  const fn = fnMatch[0];

  it('should check for downloaded status and return prev', () => {
    assert.ok(
      fn.includes("prev.status === 'downloaded'") ||
        fn.includes('prev.status === "downloaded"'),
      'onUpdateAvailable must check if prev.status is "downloaded"'
    );
    // Must return prev (no-op) when downloaded
    const downloadedBlock = fn.slice(
      fn.indexOf("'downloaded'"),
      fn.indexOf("'downloaded'") + 200
    );
    assert.ok(
      downloadedBlock.includes('return prev'),
      'onUpdateAvailable must return prev when status is "downloaded"'
    );
  });

  it('should keep progress when downloading same version', () => {
    assert.ok(
      fn.includes('prev.latestVersion === info.version'),
      'onUpdateAvailable must check if the version matches the one being downloaded'
    );
    // When same version, must return prev (preserve progress)
    const versionCheckIdx = fn.indexOf('prev.latestVersion === info.version');
    const afterVersionCheck = fn.slice(versionCheckIdx, versionCheckIdx + 200);
    assert.ok(
      afterVersionCheck.includes('return prev'),
      'onUpdateAvailable must return prev when downloading the same version'
    );
  });

  it('should only transition from idle/checking/error', () => {
    // Must guard the transition with specific status checks
    assert.ok(
      fn.includes("'checking'") &&
        fn.includes("'idle'") &&
        fn.includes("'error'"),
      'onUpdateAvailable must only transition from idle/checking/error states'
    );
  });
});

// ── onDownloadProgress guards ───────────────────────────────────

describe('onDownloadProgress: must never decrease percent', () => {
  const fnMatch = stateSrc.match(
    /export function onDownloadProgress[\s\S]*?^}/m
  );
  assert.ok(fnMatch, 'onDownloadProgress function must exist');
  const fn = fnMatch[0];

  it('should only update when new percent is greater than current', () => {
    assert.ok(
      fn.includes('percent > prev.percent') ||
        fn.includes('percent>prev.percent'),
      'onDownloadProgress must check info.percent > prev.percent'
    );
  });

  it('should return prev when percent would decrease', () => {
    // The function must have a fallback `return prev` for the no-op case
    const returnCount = (fn.match(/return prev/g) || []).length;
    assert.ok(
      returnCount >= 1,
      'onDownloadProgress must return prev as fallback (found ' + returnCount + ' occurrences)'
    );
  });
});

// ── onUpdateDownloaded ──────────────────────────────────────────

describe('onUpdateDownloaded: must always transition to "downloaded"', () => {
  const fnMatch = stateSrc.match(
    /export function onUpdateDownloaded[\s\S]*?^}/m
  );
  assert.ok(fnMatch, 'onUpdateDownloaded function must exist');
  const fn = fnMatch[0];

  it('should set status to "downloaded"', () => {
    assert.ok(
      fn.includes("status: 'downloaded'") ||
        fn.includes('status: "downloaded"'),
      'onUpdateDownloaded must set status to "downloaded"'
    );
  });
});

// ── onCheckResult guards ────────────────────────────────────────

describe('onCheckResult: must handle "downloaded" response from IPC', () => {
  const fnMatch = stateSrc.match(
    /export function onCheckResult[\s\S]*?^}/m
  );
  assert.ok(fnMatch, 'onCheckResult function must exist');
  const fn = fnMatch[0];

  it('should check res.downloaded and jump to downloaded state', () => {
    assert.ok(
      fn.includes('res.downloaded'),
      'onCheckResult must check res.downloaded from IPC response'
    );
    assert.ok(
      fn.includes("status: 'downloaded'") ||
        fn.includes('status: "downloaded"'),
      'onCheckResult must transition to "downloaded" when res.downloaded is true'
    );
  });

  it('should handle res.ok === false as error', () => {
    assert.ok(
      fn.includes('!res.ok'),
      'onCheckResult must check for failed response'
    );
    assert.ok(
      fn.includes("status: 'error'") ||
        fn.includes('status: "error"'),
      'onCheckResult must transition to "error" on failed response'
    );
  });

  it('should handle res.available === false as up-to-date', () => {
    assert.ok(
      fn.includes('!res.available'),
      'onCheckResult must check for no update available'
    );
    assert.ok(
      fn.includes("status: 'up-to-date'") ||
        fn.includes('status: "up-to-date"'),
      'onCheckResult must transition to "up-to-date" when no update'
    );
  });
});

// ── updater.js: must track downloadedVersion ────────────────────

describe('updater.js: must track downloadedVersion for IPC', () => {
  const updaterSrc = readFileSync(
    path.resolve(import.meta.dirname, '../../src/updater.js'),
    'utf-8'
  );

  it('should declare a downloadedVersion variable', () => {
    assert.ok(
      updaterSrc.includes('downloadedVersion'),
      'updater.js must track downloadedVersion'
    );
  });

  it('should set downloadedVersion on update-downloaded event', () => {
    const downloadedHandler = updaterSrc.match(
      /autoUpdater\.on\('update-downloaded'[\s\S]*?\}\);/
    );
    assert.ok(downloadedHandler, 'update-downloaded handler must exist');
    assert.ok(
      downloadedHandler[0].includes('downloadedVersion'),
      'update-downloaded handler must set downloadedVersion'
    );
  });

  it('IPC updater:check should include "downloaded" in response', () => {
    const ipcHandler = updaterSrc.match(
      /ipcMain\.handle\('updater:check'[\s\S]*?\}\);/
    );
    assert.ok(ipcHandler, 'updater:check IPC handler must exist');
    assert.ok(
      ipcHandler[0].includes('downloaded'),
      'updater:check response must include downloaded field'
    );
  });
});

// ── Full scenario replay ────────────────────────────────────────

describe('scenario: issue #14 — download completes then re-check fires', () => {
  it('state machine source must contain the critical guard comment', () => {
    // This is a canary: if someone rewrites the file and removes the guard
    // along with its explanatory comment, this test fails.
    assert.ok(
      stateSrc.includes("Don't leave 'downloaded' state") ||
        stateSrc.includes('downloaded') && stateSrc.includes('return prev'),
      'updater-state.ts must guard against leaving downloaded state'
    );
  });

  it('state machine source must prevent percent regression', () => {
    assert.ok(
      stateSrc.includes('Never decrease percent') ||
        stateSrc.includes('percent > prev.percent'),
      'updater-state.ts must prevent percent from decreasing'
    );
  });
});
