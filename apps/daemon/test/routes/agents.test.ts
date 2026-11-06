import { it } from 'node:test';
import assert from 'node:assert/strict';
import { agentsRoutes } from '../../src/routes/agents.js';
import type { RunManager } from '../../src/core/RunManager.js';
import type { AgentInfo } from '@molio/contracts';

/**
 * /api/agents must not re-probe on every hit — detection spawns CLI subprocesses
 * and the sync variant used to freeze the daemon event loop for seconds when
 * several windows loaded the first screen at once. The TTL cache itself lives in
 * RunManager.detectAgentsAsync; the route's only job is to hand back the cache
 * and to honor ?refresh=1 (settings「重新扫描」) by dropping it first.
 */
const AGENTS: AgentInfo[] = [
  { id: 'codex', name: 'Codex', available: true, models: [], installable: true },
];

function fakeManager(calls: string[]): RunManager {
  return {
    async detectAgentsAsync() {
      calls.push('detect');
      return AGENTS;
    },
    invalidateAgentCache() {
      calls.push('invalidate');
    },
  } as unknown as RunManager;
}

it('GET /api/agents serves the cached snapshot without invalidating it', async () => {
  const calls: string[] = [];
  const app = agentsRoutes(fakeManager(calls));

  const res = await app.request('/');

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agents: AGENTS });
  assert.deepEqual(calls, ['detect']);
});

it('GET /api/agents?refresh=1 drops the cache before re-probing', async () => {
  const calls: string[] = [];
  const app = agentsRoutes(fakeManager(calls));

  const res = await app.request('/?refresh=1');

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agents: AGENTS });
  // Order matters: invalidating after detection would still serve the stale snapshot.
  assert.deepEqual(calls, ['invalidate', 'detect']);
});

it('ignores refresh values other than 1', async () => {
  const calls: string[] = [];
  const app = agentsRoutes(fakeManager(calls));

  await app.request('/?refresh=0');
  await app.request('/?refresh=true');

  assert.deepEqual(calls, ['detect', 'detect']);
});
