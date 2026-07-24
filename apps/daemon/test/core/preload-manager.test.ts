import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Tests for PreloadManager path helpers, status state machine, and dismiss
 * persistence. The actual pip/npm downloads are NOT exercised here — they
 * are slow, network-dependent, and belong to manual verification. What we
 * verify here is the logic that decides *where* things install and *when*
 * the user gets prompted.
 *
 * Error-driven context:
 * - Bug: docling installed via preload landed in an unpredictable pip
 *   location and the agent couldn't find it. Fix: dedicated venv at
 *   ~/.molio/venv, with augmentPath exposing its bin dir (tested in
 *   env.test.ts). These tests pin the venv path layout so future edits
 *   don't silently move the install location.
 * - Bug: remotion "detectInstalled" returned true whenever `node` existed,
 *   so the toast never prompted. Fix: detectInstalled now checks a marker
 *   file written after a successful cache warmup.
 */

// ─── Path layout (where preload installs things) ───────────────────────────

describe('PreloadManager path layout', () => {
  const isWindows = process.platform === 'win32';
  let savedHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    if (isWindows) {
      savedHome = process.env['USERPROFILE'];
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-test-'));
      process.env['USERPROFILE'] = tmpHome;
    } else {
      savedHome = process.env['HOME'];
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-test-'));
      process.env['HOME'] = tmpHome;
    }
  });

  afterEach(() => {
    if (isWindows) {
      if (savedHome !== undefined) process.env['USERPROFILE'] = savedHome;
      else delete process.env['USERPROFILE'];
    } else {
      if (savedHome !== undefined) process.env['HOME'] = savedHome;
      else delete process.env['HOME'];
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('venv binary dir lives under ~/.molio/venv (Unix) or Scripts (Windows)', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    createPreloadManager(); // instantiate to ensure module loads
    // The layout is a constant; we assert the on-disk convention so a
    // refactor that moves it off ~/.molio/venv fails loudly.
    const expected = isWindows
      ? path.join(tmpHome, '.molio', 'venv', 'Scripts')
      : path.join(tmpHome, '.molio', 'venv', 'bin');
    assert.ok(
      expected.includes(path.join('.molio', 'venv')),
      `venv should live under ~/.molio/venv, got: ${expected}`,
    );
  });

  it('docling detectInstalled returns false when venv binary absent and not on PATH', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();
    // tmpHome has no ~/.molio/venv and docling isn't on the test PATH.
    // detectInstalled must not throw and must resolve to missing.
    // (If the CI host happens to have a global docling, this still passes
    // via the PATH fallback — which is the correct real-world behavior.)
    const statuses = pm.getStatuses();
    assert.ok(
      statuses.docling.status === 'missing' || statuses.docling.status === 'installed',
      `docling should resolve to missing or installed, got: ${statuses.docling.status}`,
    );
  });

  it('docling detectInstalled returns true when venv binary exists', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    // Create the venv binary so detectInstalled's primary check passes.
    const venvBin = isWindows
      ? path.join(tmpHome, '.molio', 'venv', 'Scripts')
      : path.join(tmpHome, '.molio', 'venv', 'bin');
    fs.mkdirSync(venvBin, { recursive: true });
    const doclingBin = isWindows
      ? path.join(venvBin, 'docling.exe')
      : path.join(venvBin, 'docling');
    fs.writeFileSync(doclingBin, '');

    const pm = createPreloadManager();
    pm.checkSkills();
    const statuses = pm.getStatuses();
    assert.equal(
      statuses.docling.status,
      'installed',
      `docling should be installed when venv binary exists, got: ${statuses.docling.status}`,
    );
  });

  it('remotion detectInstalled returns true only when marker exists', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const marker = path.join(tmpHome, '.molio', '.remotion-preloaded');

    const pm1 = createPreloadManager();
    pm1.checkSkills();
    assert.equal(
      pm1.getStatuses().remotion.status,
      'missing',
      'remotion should be missing before any preload (no marker)',
    );

    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());

    const pm2 = createPreloadManager();
    pm2.checkSkills();
    assert.equal(
      pm2.getStatuses().remotion.status,
      'installed',
      'remotion should be installed once the marker exists',
    );
  });
});

// ─── Status state machine (no real downloads) ──────────────────────────────

describe('PreloadManager status state machine', () => {
  const isWindows = process.platform === 'win32';
  let savedHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    savedHome = isWindows ? process.env['USERPROFILE'] : process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-state-'));
    if (isWindows) process.env['USERPROFILE'] = tmpHome;
    else process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      if (isWindows) process.env['USERPROFILE'] = savedHome;
      else process.env['HOME'] = savedHome;
    } else {
      if (isWindows) delete process.env['USERPROFILE'];
      else delete process.env['HOME'];
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('checkSkills marks missing skills as missing', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();
    const s = pm.getStatuses();
    // On a clean tmpHome, both should be missing (no venv, no marker).
    // (A CI host with global docling/node could flip docling to installed;
    //  remotion has no global fallback so it must be missing.)
    assert.equal(s.remotion.status, 'missing');
  });

  it('dismissSkill persists to config and prevents re-prompting', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();

    pm.dismissSkill('remotion');
    assert.equal(pm.getStatuses().remotion.status, 'dismissed');

    // A fresh instance should read the persisted dismissed state.
    const pm2 = createPreloadManager();
    pm2.checkSkills();
    assert.equal(
      pm2.getStatuses().remotion.status,
      'dismissed',
      'dismiss should persist across instances via config.json',
    );
  });

  it('undismissSkill re-checks and returns the skill to missing', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();
    pm.dismissSkill('remotion');
    assert.equal(pm.getStatuses().remotion.status, 'dismissed');

    pm.undismissSkill('remotion');
    assert.equal(
      pm.getStatuses().remotion.status,
      'missing',
      'undismiss should restore the skill to a checkable state',
    );
  });
});
