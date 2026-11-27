/**
 * Regression tests for the 2026-10-26 stale-chunk incident root cause:
 * the macOS update script used to `sleep 3` and then `rm -rf` the running
 * .app — but a normal quit takes 5–9s (daemon graceful shutdown + settle),
 * so files were regularly swapped under a still-alive app. The script must
 * now wait for the app PID to actually exit, and the quit chain in main.js
 * must never be able to hang forever.
 *
 * STRUCTURAL tests (repo convention for updater/main.js): read source as
 * text, assert the invariant patterns exist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const updaterJs = readFileSync(
  path.resolve(import.meta.dirname, '../../src/updater.js'),
  'utf-8'
);
const mainJs = readFileSync(
  path.resolve(import.meta.dirname, '../../src/main.js'),
  'utf-8'
);

describe('macOS update script: must wait for real exit, not a blind sleep', () => {
  it('script polls kill -0 on the app pid ($3)', () => {
    assert.match(
      updaterJs,
      /kill -0 "\$3"/,
      'update script must poll kill -0 "$3" until the app process is gone'
    );
  });

  it('no blind `sleep 3` wait remains', () => {
    assert.doesNotMatch(
      updaterJs,
      /sleep 3\b/,
      'blind sleep 3 was shorter than a normal quit (5–9s) — replace with the kill -0 poll loop'
    );
  });

  it('falls back to SIGKILL when the app survives the wait window', () => {
    assert.match(updaterJs, /kill -9 "\$3"/);
  });

  it('relaunches with open -n (fresh instance; single-instance lock guards duplicates)', () => {
    assert.match(updaterJs, /open -n "\$2"/);
  });

  it('spawn passes the Electron app pid to the script', () => {
    assert.match(
      updaterJs,
      /scriptPath, zipPath, appBundlePath, String\(process\.pid\)/,
      'script $3 must be the app pid so the wait loop can observe real exit'
    );
  });
});

describe('main.js: quit path must never hang forever', () => {
  it('before-quit killDaemon().then chain carries a .catch', () => {
    const pos = mainJs.indexOf("app.on('before-quit'");
    assert.ok(pos !== -1, 'before-quit handler must exist');
    const thenPos = mainJs.indexOf('killDaemon().then(', pos);
    assert.ok(thenPos !== -1, 'quit must wait for killDaemon');
    const chain = mainJs.slice(thenPos, thenPos + 400);
    assert.match(
      chain,
      /\.catch\(/,
      'a throw inside the shutdown chain (e.g. stopCryptoServer) previously left the app alive forever — must .catch and quit anyway'
    );
  });

  it('killDaemon force-timeout also resolves the wait (never waits on exit event forever)', () => {
    const killPos = mainJs.indexOf('function killDaemon()');
    assert.ok(killPos !== -1, 'killDaemon must exist');
    const block = mainJs.slice(killPos, killPos + 1600);
    assert.match(
      block,
      /forceKillDaemon\(pid\);[\s\S]{0,200}done\(\)/,
      'after the 5s force timeout, killDaemon must resolve even if the exit event never fires (daemon ignores SIGKILL) — otherwise quit hangs forever'
    );
  });
});
