import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preloadRoutes } from '../../src/routes/preload.js';
import type { PreloadManager, PreloadableSkill, SkillStatus } from '../../src/core/preload-manager.js';

/**
 * Route-level regression for the preload 重试 (retry) no-op bug (2026-07).
 *
 * The actual pip/npm downloads are NOT exercised here. We inject a duck-typed
 * PreloadManager so we can pin the route's restart-vs-alreadyDone decision —
 * the exact place the bug lived: a `failed` skill used to fall into the
 * "already done" branch, so POST /start emitted a synthetic "already installed"
 * completion and NEVER called startPreload → the error toast's 重试 button did
 * nothing visible.
 */

/** Build a duck-typed PreloadManager exposing only what /start touches.
 *  `started` records every skill the route actually (re)launches. */
function fakeManager(status: SkillStatus, started: PreloadableSkill[]): PreloadManager {
  return {
    getStatus: () => status,
    getStatuses: () => ({ docling: status, remotion: status }) as Record<PreloadableSkill, SkillStatus>,
    onProgress: () => () => { /* no-op unsub; /start never closes the stream in these stubs */ },
    startPreload: async (sk: PreloadableSkill) => { started.push(sk); },
    // not used by /start — present only to satisfy the type
    pausePreload: () => {}, stopPreload: () => {}, dismissSkill: () => {},
    undismissSkill: () => {}, checkSkills: () => {}, stopAll: () => {},
    _testHasPauseIntent: () => false,
  } as unknown as PreloadManager;
}

async function postStart(app: ReturnType<typeof preloadRoutes>, skills: string[]): Promise<Response> {
  return app.request('/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skills }),
  });
}

describe('preload /start — retry (failed skill) regression', () => {
  it('re-launches a FAILED skill so 重试 actually re-downloads', async () => {
    const started: PreloadableSkill[] = [];
    const app = preloadRoutes(fakeManager({ status: 'failed', error: 'ConnectTimeoutError' }, started));
    const res = await postStart(app, ['docling']);
    assert.equal(res.status, 200);
    assert.deepEqual(
      started,
      ['docling'],
      'a failed skill MUST be passed to startPreload — otherwise 重试 is a silent no-op',
    );
    // The stub never emits a terminal event, so the stream stays open; cancel it
    // so we don't leave an unread body around.
    await res.body?.cancel();
  });

  it('re-launches missing and paused skills', async () => {
    for (const status of [{ status: 'missing' }, { status: 'paused' }] as SkillStatus[]) {
      const started: PreloadableSkill[] = [];
      const app = preloadRoutes(fakeManager(status, started));
      const res = await postStart(app, ['docling']);
      assert.equal(res.status, 200);
      assert.deepEqual(started, ['docling'], `${status.status} must be re-started`);
      await res.body?.cancel();
    }
  });

  it('treats an installed skill as already-done: no reinstall + a synthetic completion frame', async () => {
    const started: PreloadableSkill[] = [];
    const app = preloadRoutes(fakeManager({ status: 'installed' }, started));
    const res = await postStart(app, ['docling']);
    assert.equal(res.status, 200);
    assert.deepEqual(started, [], 'an installed skill must NOT be re-started');
    // alreadyDone path: the stream closes immediately after emitting the fake
    // "already installed" completion — so the body is readable here.
    const text = await res.text();
    assert.match(text, /already installed/, 'already-done skill must get the synthetic completion frame');
    assert.match(text, /"status":"completed"/);
  });

  it('treats a downloaded skill as already-done (no re-download on retry of a success)', async () => {
    const started: PreloadableSkill[] = [];
    const app = preloadRoutes(fakeManager({ status: 'downloaded' }, started));
    const res = await postStart(app, ['docling']);
    assert.equal(res.status, 200);
    assert.deepEqual(started, [], 'a downloaded skill must NOT be re-started');
    await res.text();
  });
});
