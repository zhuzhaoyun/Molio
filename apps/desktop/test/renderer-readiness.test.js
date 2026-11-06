/**
 * Regression tests for the "clip interrupts the in-flight reply" bug (2026-09-28).
 *
 * `molio://open/...` (Chrome extension clip) is delivered two ways: in-page IPC
 * when the SPA's `molio:navigate` listener is registered, or a full `loadURL`
 * when it isn't. The loadURL fallback destroys the React tree — so if the
 * readiness gate is wrong, the clip wipes the streaming reply the user is
 * watching. That is exactly what happened: readiness was cleared on
 * `did-start-loading`, which Electron also emits for same-document SPA
 * navigation, so one in-app route change marked a healthy renderer dead forever.
 *
 * The payloads below are the REAL shapes Electron 40.10.2 hands to
 * `did-start-navigation`, captured by probing a live window:
 *
 *   pushState / replaceState / hash → isSameDocument=true,  isMainFrame=true
 *   iframe insert                  → isSameDocument=false, isMainFrame=false
 *   link click / loadURL / reload  → isSameDocument=false, isMainFrame=true
 *   (did-start-loading fires for ALL of the above — hence the bug)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRendererReadiness } from '../src/renderer-readiness.js';

const WD_ID = 7;

/** Real `did-start-navigation` payload shapes (see header). */
const NAV = {
  pushState: { url: '/knowledge?vault=v1', isSameDocument: true, isMainFrame: true },
  replaceState: { url: '/knowledge?vault=v2', isSameDocument: true, isMainFrame: true },
  hash: { url: '/knowledge?vault=v2#x', isSameDocument: true, isMainFrame: true },
  iframeInsert: { url: 'http://localhost:3100/publish', isSameDocument: false, isMainFrame: false },
  linkClick: { url: 'http://localhost:3100/knowledge?file=a.md', isSameDocument: false, isMainFrame: true },
  loadURL: { url: 'http://localhost:3100/knowledge?vault=v1', isSameDocument: false, isMainFrame: true },
  reload: { url: 'http://localhost:3100/', isSameDocument: false, isMainFrame: true },
};

/** A renderer that cold-started and then mounted its SPA. */
function bootedRenderer() {
  const readiness = createRendererReadiness();
  readiness.markReady(WD_ID);
  return readiness;
}

describe('renderer-readiness: same-document navigation must NOT clear readiness', () => {
  // The bug: React Router route changes (pushState/replaceState) and in-page
  // hash jumps recreate nothing — the SPA and its IPC listener stay alive.
  for (const kind of ['pushState', 'replaceState', 'hash']) {
    it(`stays ready across ${kind}`, () => {
      const readiness = bootedRenderer();
      assert.equal(readiness.onNavigationStarted(WD_ID, NAV[kind]), false, `${kind} must not clear readiness`);
      assert.equal(readiness.isReady(WD_ID), true);
    });
  }

  it('stays ready after many SPA route changes in a row', () => {
    // The real failure mode was cumulative: the flag never came back, so every
    // later clip reloaded. A healthy renderer must survive an arbitrary number.
    const readiness = bootedRenderer();
    for (let i = 0; i < 10; i++) readiness.onNavigationStarted(WD_ID, NAV.pushState);
    assert.equal(readiness.isReady(WD_ID), true);
  });

  it('stays ready when a subframe loads (iframe insert)', () => {
    // This is the case that produced the bug end-to-end: a subframe navigation
    // clears `did-start-loading`-based readiness and NOTHING restores it (no
    // location change → the web effect never re-runs), so every later clip
    // reloaded the window. The top document is untouched, so readiness stays.
    const readiness = bootedRenderer();
    assert.equal(readiness.onNavigationStarted(WD_ID, NAV.iframeInsert), false);
    assert.equal(readiness.isReady(WD_ID), true);
  });
});

describe('renderer-readiness: a real document swap must clear readiness', () => {
  for (const kind of ['linkClick', 'loadURL', 'reload']) {
    it(`clears readiness on ${kind}`, () => {
      const readiness = bootedRenderer();
      assert.equal(readiness.onNavigationStarted(WD_ID, NAV[kind]), true, `${kind} replaces the document`);
      assert.equal(readiness.isReady(WD_ID), false);
    });
  }

  it('does not report readiness for a webContents it has never seen', () => {
    // Cold start / a window that never sent molio:renderer-ready (e.g. the
    // daemon error page) must take the loadURL fallback, not the IPC path.
    const readiness = createRendererReadiness();
    assert.equal(readiness.isReady(999), false);
    assert.equal(readiness.get(999), undefined);
  });

  it('is defensive about a missing/empty payload', () => {
    const readiness = bootedRenderer();
    assert.equal(readiness.onNavigationStarted(WD_ID, undefined), false);
    assert.equal(readiness.isReady(WD_ID), true);
  });
});

describe('renderer-readiness: listener lifecycle', () => {
  it('markReady returns the navigation queued while the renderer was booting', () => {
    const readiness = createRendererReadiness();
    readiness.queue(WD_ID, { vaultId: 'v1', filePath: 'a.md' });
    assert.equal(readiness.isReady(WD_ID), false, 'a queued nav means the fallback path is still in play');
    assert.deepEqual(readiness.markReady(WD_ID), { vaultId: 'v1', filePath: 'a.md' });
    assert.equal(readiness.isReady(WD_ID), true);
  });

  it('flushes a queued navigation only once', () => {
    const readiness = createRendererReadiness();
    readiness.queue(WD_ID, { vaultId: 'v1', filePath: 'a.md' });
    assert.ok(readiness.markReady(WD_ID));
    assert.equal(readiness.markReady(WD_ID), null, 'a second mount must not replay the old clip');
  });

  it('markReady on an unknown webContents returns null and marks it ready', () => {
    const readiness = createRendererReadiness();
    assert.equal(readiness.markReady(WD_ID), null);
    assert.equal(readiness.isReady(WD_ID), true);
  });

  it('queue copies the target so later mutation cannot alias it', () => {
    const readiness = createRendererReadiness();
    const target = { vaultId: 'v1', filePath: 'a.md' };
    readiness.queue(WD_ID, target);
    target.filePath = 'mutated.md';
    assert.equal(readiness.markReady(WD_ID).filePath, 'a.md');
  });

  it('forget drops state (window closed, renderer gone, or nav superseded by loadURL)', () => {
    const readiness = bootedRenderer();
    readiness.forget(WD_ID);
    assert.equal(readiness.isReady(WD_ID), false);
    assert.equal(readiness.markReady(WD_ID), null);
  });
});
