import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Hono } from 'hono';
import { RunManager } from '../../src/core/RunManager.js';
import { agentsRoutes } from '../../src/routes/agents.js';

const fakeDshPath = join(
  process.cwd(),
  'test/fixtures/fake-agents',
  process.platform === 'win32' ? 'fake-dsh-acp.cmd' : 'fake-dsh-acp.mjs',
);

/**
 * Error-driven route-level tests (real-machine trap, 2026-10-04):
 *
 * dsh's session/new succeeds WITHOUT credentials (the model list comes from
 * local configOptions — no LLM call), so the card's Test button used to go
 * green on the handshake alone. The user then sent their first message and
 * hit `no API key for provider route "deepseek-official"` — "Test OK" had
 * promised a working runtime.
 *
 * With `acp.testWithPrompt` (dsh only; hermes stays handshake-only), the
 * test endpoint sends a real minimal prompt and accepts ONLY turn_end as
 * success — so missing credentials surface at test time, annotated with the
 * Molio-actionable hint from runtimes/error-hints.ts.
 */
describe('POST /agents/dsh/test — real-turn mode (acp.testWithPrompt)', () => {
  let runManager: RunManager;
  let app: Hono;
  const origEnv = { ...process.env };

  beforeEach(() => {
    runManager = new RunManager();
    app = new Hono();
    app.route('/agents', agentsRoutes(runManager));
    process.env['DSH_BIN'] = fakeDshPath;
    // Fast ACP timeouts so a hung fake fails the test quickly instead of
    // sitting in the route's 120s outer budget.
    process.env['MOLIO_ACP_IDLE_TIMEOUT_MS'] = '2000';
    process.env['MOLIO_ACP_ABSOLUTE_TIMEOUT_MS'] = '8000';
  });

  afterEach(() => {
    runManager.cancelAll();
    process.env = { ...origEnv };
  });

  it('green path: a full turn completes → ok:true', async () => {
    const res = await app.request('/agents/dsh/test', { method: 'POST' });
    const body = (await res.json()) as any;
    assert.equal(body.ok, true, `expected ok, got: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'succeeded');
  });

  it('missing API key: handshake succeeds but the prompt fails → ok:false + Molio hint', async () => {
    process.env['FAKE_DSH_NO_API_KEY'] = '1';
    const res = await app.request('/agents/dsh/test', { method: 'POST' });
    const body = (await res.json()) as any;
    // DECISIVE regression assertion: the old handshake-only logic returned
    // ok:true here — the `models` event fires right after session/new, well
    // before the (failing) prompt. Real-turn mode must wait for the turn.
    assert.equal(body.ok, false, `missing key must fail the test, got: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'failed');
    assert.match(body.error, /no API key for provider route/, 'original dsh cause must be preserved');
    assert.match(body.error, /Molio 提示/, 'actionable hint must be appended');
    delete process.env['FAKE_DSH_NO_API_KEY'];
  });
});
