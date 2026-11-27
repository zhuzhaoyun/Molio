/**
 * Regression test for the clip-interrupts-reply bug (2026-09-28).
 *
 * main.js used to clear renderer readiness on `did-start-loading`. Electron also
 * emits that event for same-document SPA navigation (pushState / replaceState /
 * hash) and for subframe loads, so one in-app route change marked a healthy
 * renderer as dead — permanently, because the SPA only re-announces readiness on
 * mount. Every subsequent clip then took the `loadURL` fallback, reloaded the
 * window and destroyed the in-flight reply.
 *
 * The gate itself is unit-tested in renderer-readiness.test.js. These tests pin
 * the WIRING in main.js, because the failure mode was wiring the wrong Electron
 * event to the readiness lifecycle — a behavioural test of the module cannot
 * catch someone re-adding it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '..', 'src');
const mainSource = readFileSync(path.join(srcDir, 'main.js'), 'utf-8');

describe('main.js clip navigation wiring (regression: clip must not reload mid-stream)', () => {
  it('must not tie renderer readiness to did-start-loading', () => {
    assert.ok(
      !mainSource.includes("'did-start-loading'"),
      'did-start-loading also fires for same-document SPA navigation and iframes — '
        + 'wiring readiness to it makes every clip after one route change reload the window',
    );
  });

  it('clears readiness from did-start-navigation via the guarded state machine', () => {
    assert.ok(
      mainSource.includes("'did-start-navigation'"),
      'main.js must observe did-start-navigation to notice real document swaps',
    );
    assert.ok(
      mainSource.includes('onNavigationStarted'),
      'the clear decision must go through renderer-readiness.js, which ignores '
        + 'same-document navigation and subframes',
    );
  });

  it('clears readiness when the renderer process dies', () => {
    // Without this the flag would stay true and the IPC would be sent into a
    // dead process — the clip would silently never open.
    assert.ok(
      mainSource.includes("'render-process-gone'"),
      'main.js must forget renderer state on render-process-gone',
    );
  });

  it('uses the readiness module rather than a raw Map', () => {
    assert.match(
      mainSource,
      /import\s*\{[^}]*createRendererReadiness[^}]*\}\s*from\s*['"]\.\/renderer-readiness\.js['"]/,
      'main.js must import createRendererReadiness from ./renderer-readiness.js',
    );
  });
});

describe('renderer-readiness.js guard (the actual fix)', () => {
  const moduleSource = readFileSync(path.join(srcDir, 'renderer-readiness.js'), 'utf-8');

  it('ignores same-document navigation', () => {
    assert.match(moduleSource, /isSameDocument/, 'the guard must check isSameDocument');
  });

  it('ignores subframe (iframe) loads', () => {
    assert.match(moduleSource, /isMainFrame/, 'the guard must check isMainFrame');
  });
});
