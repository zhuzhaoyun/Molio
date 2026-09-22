/**
 * detectAgentsAsync — TTL cache, in-flight dedup, parallel probing, and the
 * availability semantics carried over from the old sync detectAgents.
 *
 * Regression context (startup perf, 2026-09): the sync detectAgents froze the
 * daemon event loop for seconds (execFileSync per agent CLI) on every
 * GET /api/agents, serializing the whole web first-screen request storm.
 * The async path must never re-probe within the TTL and must share one probe
 * round across concurrent callers.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RunManager } from '../../src/core/RunManager.js';
import { listAgentDefs } from '../../src/core/runtimes/registry.js';
import type { ResolveResult, ProbeResult } from '../../src/core/runtimes/launch.js';

const DEFS = listAgentDefs();

interface Harness {
  rm: RunManager;
  probeCalls: string[];
  resolveCalls: string[];
  advance(ms: number): void;
}

function makeHarness(opts: {
  missingIds?: Set<string>;
  failingIds?: Set<string>;
  probeDelayMs?: number;
} = {}): Harness {
  let clock = 0;
  const probeCalls: string[] = [];
  const resolveCalls: string[] = [];
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const rm = new RunManager({
    now: () => clock,
    resolve: async (def): Promise<ResolveResult> => {
      resolveCalls.push(def.id);
      if (opts.missingIds?.has(def.id)) {
        return { binary: null, source: 'not-found' };
      }
      return { binary: `/fake/bin/${def.bin}`, source: 'path' };
    },
    probe: async (bin, _args): Promise<ProbeResult> => {
      probeCalls.push(bin);
      if (opts.probeDelayMs) await delay(opts.probeDelayMs);
      const id = DEFS.find((d) => bin.endsWith(d.bin))?.id ?? '';
      if (opts.failingIds?.has(id)) {
        return { version: null, error: 'boom' };
      }
      return { version: '9.9.9' };
    },
  });

  return {
    rm,
    probeCalls,
    resolveCalls,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const savedTtlEnv = process.env['MOLIO_AGENT_CACHE_TTL_MS'];
afterEach(() => {
  if (savedTtlEnv === undefined) delete process.env['MOLIO_AGENT_CACHE_TTL_MS'];
  else process.env['MOLIO_AGENT_CACHE_TTL_MS'] = savedTtlEnv;
});

describe('detectAgentsAsync cache + dedup', () => {
  it('probes every registered agent once and returns full list', async () => {
    const h = makeHarness();
    const agents = await h.rm.detectAgentsAsync();

    assert.equal(agents.length, DEFS.length);
    assert.equal(h.probeCalls.length, DEFS.length);
    for (const a of agents) {
      assert.equal(a.available, true);
      assert.equal(a.version, '9.9.9');
      assert.equal(a.probeError, null);
    }
  });

  it('serves from cache within the TTL (no re-probe)', async () => {
    const h = makeHarness();
    const first = await h.rm.detectAgentsAsync();
    h.advance(29_000); // just under the 30s default
    const second = await h.rm.detectAgentsAsync();

    assert.equal(h.probeCalls.length, DEFS.length, 'must not re-probe within TTL');
    assert.equal(second, first, 'cached array identity is reused');
  });

  it('re-probes after the TTL expires', async () => {
    const h = makeHarness();
    await h.rm.detectAgentsAsync();
    h.advance(31_000);
    await h.rm.detectAgentsAsync();

    assert.equal(h.probeCalls.length, DEFS.length * 2);
  });

  it('TTL=0 env disables caching entirely', async () => {
    process.env['MOLIO_AGENT_CACHE_TTL_MS'] = '0';
    const h = makeHarness();
    await h.rm.detectAgentsAsync();
    await h.rm.detectAgentsAsync();

    assert.equal(h.probeCalls.length, DEFS.length * 2);
  });

  it('dedupes concurrent callers into a single probe round', async () => {
    const h = makeHarness({ probeDelayMs: 20 });
    const [a, b] = await Promise.all([
      h.rm.detectAgentsAsync(),
      h.rm.detectAgentsAsync(),
    ]);

    assert.equal(h.probeCalls.length, DEFS.length, 'one shared in-flight round');
    assert.equal(a, b);
  });

  it('invalidateAgentCache forces a fresh probe on next call', async () => {
    const h = makeHarness();
    await h.rm.detectAgentsAsync();
    h.rm.invalidateAgentCache();
    await h.rm.detectAgentsAsync();

    assert.equal(h.probeCalls.length, DEFS.length * 2);
  });

  it('a failed in-flight round does not poison the cache', async () => {
    let rejectNext = true;
    let clock = 0;
    const rm = new RunManager({
      now: () => clock,
      resolve: async () => {
        if (rejectNext) {
          rejectNext = false;
          throw new Error('transient resolve failure');
        }
        return { binary: '/fake/bin/x', source: 'path' as const };
      },
      probe: async () => ({ version: '1.0.0' }),
    });

    await assert.rejects(() => rm.detectAgentsAsync(), /transient/);
    // The rejected round must not leave a stuck in-flight promise behind.
    const agents = await rm.detectAgentsAsync();
    assert.ok(agents.every((a) => a.available));
    void clock;
  });
});

describe('detectAgentsAsync availability semantics (parity with sync detect)', () => {
  const firstDef = DEFS[0]!;
  const secondDef = DEFS[1]!;

  it('binary that exists but fails its probe is NOT available', async () => {
    const failing = new Set([firstDef.id]);
    const h = makeHarness({ failingIds: failing });
    const agents = await h.rm.detectAgentsAsync();

    const failed = agents.find((a) => a.id === firstDef.id)!;
    assert.equal(failed.available, false);
    assert.equal(failed.probeError, 'boom');
    assert.equal(failed.version, null);

    const healthy = agents.find((a) => a.id === secondDef.id)!;
    assert.equal(healthy.available, true);
  });

  it('unresolved agent skips probing entirely', async () => {
    const missing = new Set([firstDef.id]);
    const h = makeHarness({ missingIds: missing });
    const agents = await h.rm.detectAgentsAsync();

    assert.equal(h.probeCalls.length, DEFS.length - 1, 'no probe for missing binary');
    const m = agents.find((a) => a.id === firstDef.id)!;
    assert.equal(m.available, false);
    assert.equal(m.binary, null);
    assert.equal(m.source, 'not-found');
    assert.equal(m.probeError, null);
  });
});
