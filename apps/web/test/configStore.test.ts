/**
 * configStore — shared /api/config snapshot with in-flight dedup.
 *
 * Regression context (startup perf, 2026-09): App.tsx used to fire three
 * independent getConfig() calls and gate the entire UI behind `configLoaded`
 * (white screen until the daemon answered). The store must:
 *   - share ONE in-flight request across concurrent refresh() callers;
 *   - never throw when the daemon is unreachable (keeps last snapshot);
 *   - mirror successful updateConfig writes via applyPatch.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Silence the expected [configStore] refresh failed warning in the error test.
const realWarn = console.warn;

const { configStore, __setConfigFetcher } = await import('../src/stores/configStore.ts');

// Test seam: the store's real fetcher dynamically imports api/client (unreachable
// under plain node:test). Swap in a programmable stub and count calls.
let fetchCalls = 0;
let fetchImpl: () => Promise<Record<string, unknown>>;
__setConfigFetcher(async () => {
  fetchCalls += 1;
  return fetchImpl();
});

function jsonResponse(body: Record<string, unknown>) {
  return body;
}

beforeEach(() => {
  fetchCalls = 0;
  // Reset module-level snapshot between tests via applyPatch-free path:
  // refresh() with a stubbed response overwrites it anyway.
});

describe('configStore', () => {
  it('refresh() populates the snapshot and notifies subscribers', async () => {
    fetchImpl = async () => jsonResponse({ defaultAgentId: 'claude', locale: 'zh' });
    let notified = 0;
    const unsub = configStore.subscribe(() => { notified += 1; });

    const result = await configStore.refresh();
    assert.deepStrictEqual(result, { defaultAgentId: 'claude', locale: 'zh' });
    assert.deepStrictEqual(configStore.getConfig(), { defaultAgentId: 'claude', locale: 'zh' });
    assert.equal(notified, 1);
    unsub();
  });

  it('concurrent refresh() calls share ONE in-flight request', async () => {
    let release!: (v: Record<string, unknown>) => void;
    fetchImpl = () => new Promise<Record<string, unknown>>((r) => { release = r; });

    const p1 = configStore.refresh();
    const p2 = configStore.refresh();
    const p3 = configStore.refresh();
    assert.equal(fetchCalls, 1, 'dedup: only one HTTP request');

    release(jsonResponse({ defaultAgentId: 'codex' }));
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.deepStrictEqual(configStore.getConfig(), { defaultAgentId: 'codex' });
  });

  it('refresh() never throws — daemon failure keeps the last snapshot', async () => {
    // Seed a known snapshot first.
    fetchImpl = async () => jsonResponse({ locale: 'en' });
    await configStore.refresh();

    console.warn = () => {};
    try {
      fetchImpl = async () => { throw new Error('daemon down'); };
      const result = await configStore.refresh();
      assert.deepStrictEqual(result, { locale: 'en' }, 'keeps last snapshot');
      assert.deepStrictEqual(configStore.getConfig(), { locale: 'en' });
    } finally {
      console.warn = realWarn;
    }

    // A later successful refresh recovers and replaces the snapshot.
    fetchImpl = async () => jsonResponse({ locale: 'zh' });
    await configStore.refresh();
    assert.deepStrictEqual(configStore.getConfig(), { locale: 'zh' });
  });

  it('after a failure the in-flight slot is cleared (next refresh retries)', async () => {
    console.warn = () => {};
    try {
      fetchImpl = async () => { throw new Error('boom'); };
      await configStore.refresh();
    } finally {
      console.warn = realWarn;
    }
    fetchImpl = async () => jsonResponse({ defaultAgentId: 'gemini' });
    const before = fetchCalls;
    const result = await configStore.refresh();
    assert.equal(fetchCalls, before + 1, 'must issue a NEW request');
    assert.deepStrictEqual(result, { defaultAgentId: 'gemini' });
  });

  it('applyPatch merges into the snapshot without a network call', async () => {
    fetchImpl = async () => jsonResponse({ defaultAgentId: 'claude', defaultCwd: '/old' });
    await configStore.refresh();
    const before = fetchCalls;

    let notified = 0;
    const unsub = configStore.subscribe(() => { notified += 1; });
    configStore.applyPatch({ defaultCwd: '/new-vault' });

    assert.equal(fetchCalls, before, 'applyPatch must not hit the network');
    assert.deepStrictEqual(configStore.getConfig(), {
      defaultAgentId: 'claude',
      defaultCwd: '/new-vault',
    });
    assert.equal(notified, 1);
    unsub();
  });
});
