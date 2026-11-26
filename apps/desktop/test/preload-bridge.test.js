/**
 * Seam pin test: the web diagnostics panel (apps/web checkupActions.ts) reads
 * getLogPath from window.updater — NOT window.__electron__. Regression: the
 * panel used to read it from __electron__, where preload never exposed it, so
 * the 「打开日志文件夹」 button could never render in the real app.
 *
 * Source-text assertion (same pattern as daemon-startup.test.js): preload.cjs
 * runs inside Electron's isolated preload context, which plain node:test
 * cannot load, so we pin the exposed surface by reading the source instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const preload = readFileSync(
  new URL('../src/preload.cjs', import.meta.url),
  'utf-8',
);

/** Source extent of `const NAME = {` … its closing `};` (inclusive of body, exclusive of braces). */
function objectLiteralBody(src, name) {
  const marker = `const ${name} = {`;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `preload.cjs must declare ${marker}`);
  const bodyStart = start + marker.length;
  const end = src.indexOf('\n};', bodyStart);
  assert.ok(end !== -1, `the ${name} object literal must be closed with "};".`);
  return src.slice(bodyStart, end);
}

describe('preload.cjs: updater bridge must keep getLogPath (web diagnostics seam)', () => {
  const updaterBody = objectLiteralBody(preload, 'updaterAPI');

  it('updaterAPI must expose getLogPath -> updater:log-path IPC', () => {
    assert.ok(
      /getLogPath:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('updater:log-path'\)/.test(updaterBody),
      'updaterAPI must expose getLogPath() invoking updater:log-path — the checkup panel opens the log folder through it'
    );
  });

  it('updaterAPI must be exposed as window.updater', () => {
    assert.ok(
      preload.includes("exposeInMainWorld('updater', updaterAPI)"),
      'preload must expose the updater API as window.updater'
    );
  });

  it('desktopAPI (__electron__) must NOT carry getLogPath', () => {
    // Guard against "fixing" the missing button by duplicating the method on
    // the wrong bridge instead of keeping the web layer pointed at updater.
    const desktopBody = objectLiteralBody(preload, 'desktopAPI');
    assert.ok(
      !desktopBody.includes('getLogPath'),
      'getLogPath belongs to the updater bridge only — the web layer reads window.updater.getLogPath'
    );
  });
});
