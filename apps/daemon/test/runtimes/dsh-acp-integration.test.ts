import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AgentEvent } from '@molio/contracts';
import { RunManager } from '../../src/core/RunManager.js';
import { getAgentDef } from '../../src/core/runtimes/registry.js';

const fakeDshPath = join(
  process.cwd(),
  'test/fixtures/fake-agents',
  process.platform === 'win32' ? 'fake-dsh-acp.cmd' : 'fake-dsh-acp.mjs',
);

/**
 * Integration test: RunManager ACP path against a fake dsh (DeepSeek Harness)
 * ACP server. dsh differs from hermes in three protocol ways, each covered:
 *
 *  1. session/new returns `configOptions` (grouped model select, values are
 *     JSON [provider, model] tuples) instead of `models.availableModels` →
 *     parseConfigOptionsModels must flatten it into the `models` event.
 *  2. Model switching uses `session/set_config_option` — and an unavailable
 *     user-selected model must FAIL the run (never silently fall back).
 *  3. dsh issues server-initiated `session/request_permission` requests →
 *     AcpTransport.handleServerRequest must auto-answer or the agent blocks.
 *
 * Plus dsh-specific stderr classification (warnings stay `raw`, only explicit
 * `dsh: error` / `Error:` lines escalate) and the preflightRepair guard
 * (`dsh --check` exits 1, so the hermes-style probe must NOT run for dsh).
 */
describe('RunManager ACP integration (dsh)', () => {
  let runManager: RunManager;
  const origEnv = { ...process.env };

  beforeEach(() => {
    runManager = new RunManager();
    // launch.ts computes envKey as `${def.id.toUpperCase()}_BIN` = 'DSH_BIN'
    process.env['DSH_BIN'] = fakeDshPath;
    // Fast ACP timeouts so a blocked/hung fake fails the test quickly.
    // Idle must tolerate slow spawns under full-suite parallel load (cmd wrapper
    // → node → .mjs can exceed 500ms before initialize replies on a busy box);
    // the absolute timeout still caps genuine hangs.
    process.env['MOLIO_ACP_IDLE_TIMEOUT_MS'] = '2000';
    process.env['MOLIO_ACP_ABSOLUTE_TIMEOUT_MS'] = '8000';
  });

  afterEach(() => {
    runManager.cancelAll();
    process.env = { ...origEnv };
  });

  /**
   * Collect events until `until(ev)` matches. With `drainMs > 0`, keep the
   * subscription open a little longer before resolving — stderr arrives on a
   * separate pipe and its events can be processed AFTER the turn_end that came
   * via stdout (observed under full-suite parallel load).
   */
  function collectEvents(runId: string, until: (ev: AgentEvent) => boolean, drainMs = 0): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const inner = new Promise<AgentEvent[]>((resolve, reject) => {
      let draining = false;
      const unsub = runManager.onEvent(runId, (ev) => {
        events.push(ev);
        if (draining) return;
        if (until(ev)) {
          if (drainMs > 0) {
            draining = true;
            setTimeout(() => {
              unsub?.();
              resolve(events);
            }, drainMs);
          } else {
            unsub?.();
            resolve(events);
          }
        }
      });
      if (!unsub) reject(new Error(`run ${runId} not found`));
    });
    // Guard: if the fake blocks (e.g. an unanswered server request), fail the
    // test instead of hanging the whole suite.
    return Promise.race([
      inner,
      new Promise<AgentEvent[]>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for events; got: ${events.map((e) => e.type).join(',')}`)), 10_000)),
    ]);
  }

  function waitForTerminal(runId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for terminal status')), 10_000);
      const check = () => {
        const info = runManager.getRunInfo(runId);
        if (info && ['succeeded', 'failed', 'canceled'].includes(info.status)) {
          clearTimeout(timer);
          resolve(info.status);
          return;
        }
        setTimeout(check, 30);
      };
      check();
    });
  }

  it('dsh def must NOT enable acp.preflightRepair (dsh --check exits 1)', () => {
    const def = getAgentDef('dsh')!;
    assert.ok(def, 'dsh must be registered');
    assert.equal(def.transport, 'acp-jsonrpc');
    assert.equal(
      def.acp?.preflightRepair,
      undefined,
      'dsh rejects unknown flags ("--profile <name> is required", exit 1) — '
      + 'the hermes-style `bin --check` probe would fail every run pre-spawn',
    );
    assert.equal(def.multiTurn, true);
    // The handshake idle timer only resets on stdout, and a freshly installed
    // dsh tree (Defender-scanned on first launch) stayed stdout-silent past
    // 15s on a real Windows machine → failed "Install → Test" (measured cold
    // handshake: 27.8s; warm: 1.9s). The window must leave headroom over the
    // measured cold start for slower machines.
    assert.ok(
      (def.acp?.idleTimeoutMs ?? 0) >= 60000,
      `dsh acp.idleTimeoutMs must be >= 60s for cold-start AV scans, got ${def.acp?.idleTimeoutMs}`,
    );
    // The Test button must run a REAL minimal turn: dsh's session/new
    // succeeds WITHOUT credentials, so a handshake-only test green-lights a
    // missing API key and the user hits the wall on their first message
    // (real-machine trap, 2026-10-04).
    assert.equal(def.acp?.testWithPrompt, true);
    assert.equal(
      getAgentDef('hermes')?.acp?.testWithPrompt,
      undefined,
      'hermes must stay handshake-only — LLM latency would make its test flaky',
    );
  });

  it('session/new configOptions → models event with tuple-slug ids', async () => {
    const runId = await runManager.createRun({ agentId: 'dsh', message: 'hi' });
    const events = await collectEvents(runId, (ev) => ev.type === 'turn_end');

    const types = events.map((e) => e.type);
    assert.ok(types.includes('models'), 'configOptions must produce a models event');
    assert.ok(types.includes('text_delta'), 'agent_message_chunk → text_delta');
    assert.ok(types.includes('tool_use'), 'tool_call → tool_use');
    assert.ok(types.includes('tool_result'), 'tool_call_update → tool_result');

    const modelsEv = events.find((e) => e.type === 'models') as Extract<AgentEvent, { type: 'models' }>;
    // ids are the tuple's model slug (matching fallbackModels), labels the display names
    assert.deepEqual(
      modelsEv.models.map((m) => m.id),
      ['deepseek-v4-flash', 'deepseek-v4-pro'],
    );
    assert.equal(modelsEv.models[0]?.label, 'DeepSeek V4 Flash');
    assert.equal(modelsEv.currentModelId, 'deepseek-v4-flash');

    const turnEnd = events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
    assert.equal(turnEnd.stopReason, 'end_turn');
  });

  it('model selection is applied via session/set_config_option', async () => {
    const runId = await runManager.createRun({
      agentId: 'dsh',
      message: 'hi',
      model: 'deepseek-v4-pro',
    });
    const events = await collectEvents(runId, (ev) => ev.type === 'models');
    const modelsEv = events.find((e) => e.type === 'models') as Extract<AgentEvent, { type: 'models' }>;
    assert.equal(
      modelsEv.currentModelId,
      'deepseek-v4-pro',
      'currentModelId must reflect the applied set_config_option selection',
    );
  });

  it('unavailable model fails the run (no silent fallback)', async () => {
    process.env['FAKE_DSH_MODEL_MISSING'] = '1';
    const runId = await runManager.createRun({
      agentId: 'dsh',
      message: 'hi',
      model: 'deepseek-v4-pro', // fake only advertises deepseek-v4-flash
    });
    const status = await waitForTerminal(runId);
    assert.equal(status, 'failed');
    delete process.env['FAKE_DSH_MODEL_MISSING'];
  });

  it('missing API key error is annotated with a Molio-actionable hint', async () => {
    process.env['FAKE_DSH_NO_API_KEY'] = '1';
    const runId = await runManager.createRun({ agentId: 'dsh', message: 'hi' });
    const events = await collectEvents(runId, (ev) => ev.type === 'error');
    const errEv = events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
    // Real-world failure (2026-10-04): dsh's own text advises "the credentials
    // service (the web Models page writes it)" — concepts Molio doesn't have.
    // The original cause must survive (diagnostics) AND a Molio hint pointing
    // at 设置→运行时→DeepSeek Harness→配置 must be appended.
    assert.ok(
      errEv.message.includes('no API key for provider route'),
      `original dsh cause must be preserved, got: ${errEv.message}`,
    );
    assert.ok(
      errEv.message.includes('Molio 提示') && errEv.message.includes('设置')
        && errEv.message.includes('DeepSeek Harness'),
      `Molio-actionable hint must be appended, got: ${errEv.message}`,
    );
    const status = await waitForTerminal(runId);
    assert.equal(status, 'failed');
    delete process.env['FAKE_DSH_NO_API_KEY'];
  });

  it('session/request_permission is auto-approved and the turn completes', async () => {
    process.env['FAKE_DSH_REQUEST_PERMISSION'] = '1';
    const runId = await runManager.createRun({ agentId: 'dsh', message: 'hi' });
    // The fake ONLY streams the turn after the permission answer arrives —
    // reaching turn_end proves the transport answered the server request.
    const events = await collectEvents(runId, (ev) => ev.type === 'turn_end');

    const raws = events
      .filter((e): e is Extract<AgentEvent, { type: 'raw' }> => e.type === 'raw')
      .map((e) => e.line);
    assert.ok(
      raws.some((l) => l.includes('auto-approved permission request') && l.includes('allow')),
      `expected auto-approve decision log, got: ${JSON.stringify(raws)}`,
    );
    assert.ok(events.some((e) => e.type === 'text_delta'), 'turn should stream after auto-approve');
    delete process.env['FAKE_DSH_REQUEST_PERMISSION'];
  });

  it('permission request with no options is answered cancelled (no hang)', async () => {
    process.env['FAKE_DSH_PERMISSION_NO_OPTIONS'] = '1';
    const runId = await runManager.createRun({ agentId: 'dsh', message: 'hi' });
    const events = await collectEvents(runId, (ev) => ev.type === 'turn_end');
    const raws = events
      .filter((e): e is Extract<AgentEvent, { type: 'raw' }> => e.type === 'raw')
      .map((e) => e.line);
    assert.ok(
      raws.some((l) => l.includes('no selectable options')),
      `expected cancelled-answer log, got: ${JSON.stringify(raws)}`,
    );
    delete process.env['FAKE_DSH_PERMISSION_NO_OPTIONS'];
  });

  it('dsh stderr: warnings stay raw, explicit errors escalate, turn survives', async () => {
    process.env['FAKE_DSH_STDERR_SAMPLE'] = '1';
    const runId = await runManager.createRun({ agentId: 'dsh', message: 'hi' });
    // drainMs: stderr events (raw warning / escalated error) travel on a
    // separate pipe and may be processed just after the stdout turn_end.
    const events = await collectEvents(runId, (ev) => ev.type === 'turn_end', 500);

    const raws = events
      .filter((e): e is Extract<AgentEvent, { type: 'raw' }> => e.type === 'raw')
      .map((e) => e.line);
    const errors = events
      .filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
      .map((e) => e.message);

    assert.ok(
      raws.some((l) => l.includes('dsh: warning: 1 entry did not activate')),
      `benign dsh warning must stay a raw event, got raws: ${JSON.stringify(raws)}`,
    );
    assert.ok(
      !errors.some((m) => m.includes('warning')),
      `warnings must NOT escalate to error events, got: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((m) => m.includes('dsh: error: provider key missing')),
      `explicit dsh error must surface as error event, got: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      events.some((e) => e.type === 'text_delta'),
      'a stderr warning must not swallow the reply stream',
    );
    delete process.env['FAKE_DSH_STDERR_SAMPLE'];
  });

  it('process exit mid-prompt is marked failed', async () => {
    process.env['FAKE_DSH_EXIT_DURING_PROMPT'] = '1';
    const runId = await runManager.createRun({ agentId: 'dsh', message: 'hi' });
    const status = await waitForTerminal(runId);
    assert.equal(status, 'failed');
    delete process.env['FAKE_DSH_EXIT_DURING_PROMPT'];
  });
});
