import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentEvent } from '@molio/contracts';
import { RunManager } from '../../src/core/RunManager.js';
import { getAgentDef } from '../../src/core/runtimes/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeHermesPath = join(
  process.cwd(),
  'test/fixtures/fake-agents',
  process.platform === 'win32' ? 'fake-hermes-acp.cmd' : 'fake-hermes-acp.mjs',
);

/**
 * Integration test: RunManager ACP path against a fake hermes-acp server.
 * Covers the full createRun → initialize → session/new → sendMessage →
 * session/prompt → turn_end flow, plus cancel and process-exit edge cases.
 *
 * Per CLAUDE.md integration-test rules: drives state transitions via a
 * realistic fake server (not just method return values), and verifies
 * negative behavior (timeout, process exit, cancelled-session discard).
 */

describe('RunManager ACP integration (Hermes)', () => {
  let runManager: RunManager;
  const origEnv = { ...process.env };

  beforeEach(() => {
    runManager = new RunManager();
    // launch.ts computes envKey as `${def.id.toUpperCase()}_BIN` = 'HERMES_BIN'
    process.env['HERMES_BIN'] = fakeHermesPath;
    // Fast-but-load-tolerant ACP timeouts for tests (overrides RunManager
    // defaults). Idle=3000ms means "if fake-hermes goes silent for 3s, time
    // out"; absolute=10000ms is the safety net. NOT 500/2000: under full-suite
    // parallel load on Windows, node spawn latency for the fake server alone
    // can exceed 500ms → initialize idle-times-out → the run fails before
    // 'models' ever fires and the waiting test hangs for its whole 30s budget
    // (observed twice on the sendMessage test). 3s keeps the timeout tests
    // quick while tolerating a loaded dev machine; fixture delays that must
    // EXCEED the idle budget are scaled to match (search for 4000).
    process.env['MOLIO_ACP_IDLE_TIMEOUT_MS'] = '3000';
    process.env['MOLIO_ACP_ABSOLUTE_TIMEOUT_MS'] = '10000';
  });

  afterEach(() => {
    runManager.cancelAll();
    process.env = { ...origEnv };
  });

  function collectEvents(runId: string, until: (ev: AgentEvent) => boolean): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    return new Promise((resolve, reject) => {
      const unsub = runManager.onEvent(runId, (ev) => {
        events.push(ev);
        if (until(ev)) {
          unsub?.();
          resolve(events);
        }
      });
      if (!unsub) {
        reject(new Error(`run ${runId} not found`));
      }
    });
  }

  function waitForStatus(runId: string, status: 'succeeded' | 'failed' | 'canceled'): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const info = runManager.getRunInfo(runId);
        if (info?.status === status) { resolve(); return; }
        setTimeout(check, 30);
      };
      check();
    });
  }

  it('runs full ACP flow: initialize → session/new → prompt → turn_end', async () => {
    const def = getAgentDef('hermes')!;
    assert.equal(def.transport, 'acp-jsonrpc');

    const runId = await runManager.createRun({
      agentId: 'hermes',
      message: 'hi',
    });

    const events = await collectEvents(runId, (ev) => ev.type === 'turn_end');

    // Should see: status running, models event, text_delta, tool_use, tool_result, turn_end
    const types = events.map((e) => e.type);
    assert.ok(types.includes('models'), 'models event should fire after session/new');
    assert.ok(types.includes('text_delta'), 'agent_message_chunk → text_delta');
    assert.ok(types.includes('tool_use'), 'tool_call → tool_use');
    assert.ok(types.includes('tool_result'), 'tool_call_update → tool_result');
    assert.ok(types.includes('turn_end'), 'prompt response → turn_end');

    const turnEnd = events.find((e) => e.type === 'turn_end') as Extract<AgentEvent, { type: 'turn_end' }>;
    assert.equal(turnEnd.stopReason, 'end_turn');

    const modelsEv = events.find((e) => e.type === 'models') as Extract<AgentEvent, { type: 'models' }>;
    assert.equal(modelsEv.models.length, 2);
    assert.equal(modelsEv.currentModelId, 'fake:model-a');
  });

  it('sendMessage triggers session/prompt and emits turn_end', async () => {
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'first' });
    // Wait for init to complete (models event signals session/new done)
    await collectEvents(runId, (ev) => ev.type === 'models');

    // Send a follow-up message — should drive a new session/prompt
    const promptEvents = collectEvents(runId, (ev) => ev.type === 'turn_end');
    runManager.sendMessage(runId, 'second message');
    const events = await promptEvents;
    assert.ok(events.some((e) => e.type === 'text_delta'));
    assert.ok(events.some((e) => e.type === 'turn_end'));
  });

  it('canAcceptMessage returns false while ACP session is initializing (P1-3)', async () => {
    // P1-3: during initAcpPooled, run.acp is undefined (pool acquire still
    // spawning/initializing) or exists with sessionId '' (session/new hasn't
    // resolved). canAcceptMessage must return false in both windows so callers
    // like WeixinService don't fire session/prompt at a half-initialized session.
    process.env['FAKE_HERMES_SLOW_INIT_MS'] = '5000';
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    // Let initAcpPooled's sync part run (pool acquire is awaiting initialize).
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runManager.canAcceptMessage(runId), false);
    runManager.cancelRun(runId);
  });

  it('canAcceptMessage returns true after ACP session is initialized', async () => {
    // After session/new resolves, sessionId is non-empty and stdin is open
    // for multi-turn follow-ups. canAcceptMessage must return true so
    // WeixinService can reuse the session instead of spawning a fresh run.
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    await collectEvents(runId, (ev) => ev.type === 'models');
    assert.equal(runManager.canAcceptMessage(runId), true);
    runManager.cancelRun(runId);
  });

  it('cancelRun terminates the run but keeps the pooled process warm for reuse', async () => {
    // Pooled cancel semantics: cancelRun detaches THIS run's session and marks
    // it canceled, but the shared process must survive — killing it (the old
    // 1-run-1-process behavior) is exactly what made every retry / new
    // conversation pay the ~14s cold start again.
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    await collectEvents(runId, (ev) => ev.type === 'models');

    const pool = runManager.__getAcpPool();
    const entryBefore = pool.__getEntry('hermes');
    assert.ok(entryBefore, 'pool must hold the warm hermes process');
    const pidBefore = entryBefore.child.pid;

    runManager.cancelRun(runId);
    await waitForStatus(runId, 'canceled');

    assert.equal(entryBefore.alive, true, 'process must SURVIVE cancelRun');
    assert.equal(pool.__getEntry('hermes'), entryBefore, 'entry must stay pooled');

    // A second run reuses the same process: same entry, same pid — and since
    // the pool runs `initialize` only at spawn, reuse means no second handshake.
    const runId2 = await runManager.createRun({ agentId: 'hermes', message: 'hi again' });
    const events2 = await collectEvents(runId2, (ev) => ev.type === 'turn_end');
    assert.ok(events2.some((e) => e.type === 'models'), 'reused session still reports models');
    assert.ok(events2.some((e) => e.type === 'text_delta'), 'reused process must stream a reply');

    const entryAfter = pool.__getEntry('hermes');
    assert.equal(entryAfter, entryBefore, 'second run must reuse the same pool entry');
    assert.equal(entryAfter?.child.pid, pidBefore, 'second run must ride the same OS process');
  });

  it('cancelRun + process exit does not emit spurious prompt-failed error', async () => {
    // OCR fix: rejectAll() clears cancelledSessionIds before the pending
    // session/prompt's .catch runs. Without the TERMINAL_STATUSES guard,
    // .catch sees isCancelled=false and emits a misleading "prompt failed:
    // hermes-acp process exited" error event for a run the user already
    // cancelled — polluting the UI with a red banner for an intentional action.
    //
    // Pooled repro: hang the prompt so a session/prompt is genuinely pending,
    // cancelRun (detaches the session but keeps the process alive), then drain
    // the pool — the pool's process-exit path. Its rejectAll rejects the
    // still-pending prompt against an already-terminal run.
    process.env['FAKE_HERMES_PROMPT_HANG_WITH_STDERR'] = '1';

    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    await collectEvents(runId, (ev) => ev.type === 'models');
    // Wait for the first stderr heartbeat so we know the prompt was received
    // and is pending (the fake server prints one INFO line ~50ms after prompt).
    await new Promise((r) => setTimeout(r, 120));

    const errorMessages: string[] = [];
    const unsub = runManager.onEvent(runId, (ev) => {
      if (ev.type === 'error') errorMessages.push(ev.message);
    });

    runManager.cancelRun(runId);
    await waitForStatus(runId, 'canceled');

    // Kill the warm process the pooled way (drain = provider-config change /
    // shutdown). finalizeEntry's rejectAll fires the pending prompt's .catch —
    // the exact race the terminal guard must swallow.
    runManager.drainAcpPool('hermes');
    // Grace period for the rejectAll + .catch microtask to fire.
    await new Promise((r) => setTimeout(r, 200));
    unsub?.();

    const spurious = errorMessages.find(m => m.includes('prompt failed'));
    assert.equal(
      spurious,
      undefined,
      `cancelled run should not emit a "prompt failed" error, got: ${JSON.stringify(errorMessages)}`,
    );

    delete process.env['FAKE_HERMES_PROMPT_HANG_WITH_STDERR'];
  });

  it('process exit mid-prompt is marked failed (not succeeded)', async () => {
    // Without the close-handler fix, a process exiting with code 0 while a
    // session/prompt is pending would be marked 'succeeded' — contradicting
    // the rejected prompt. The fix checks `transport.hasPending()` first.
    process.env['FAKE_HERMES_EXIT_DURING_PROMPT'] = '1';
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    await waitForStatus(runId, 'failed');
    delete process.env['FAKE_HERMES_EXIT_DURING_PROMPT'];
  });

  it('initialize idle-timeout emits error and fails the run', async () => {
    process.env['FAKE_HERMES_NO_INIT'] = '1';
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });

    // With MOLIO_ACP_IDLE_TIMEOUT_MS=3000 + FAKE_HERMES_NO_INIT=1, fake-hermes
    // goes totally silent → idle timer fires after ~3s with an error
    // containing 'idle' and 'timeout'.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout test timed out')), 8000);
      const unsub = runManager.onEvent(runId, (ev) => {
        if (ev.type === 'error' && ev.message.includes('idle') && ev.message.includes('timeout')) {
          clearTimeout(timer);
          unsub?.();
          resolve();
        }
      });
      if (!unsub) {
        clearTimeout(timer);
        reject(new Error(`run ${runId} not found`));
      }
    });

    delete process.env['FAKE_HERMES_NO_INIT'];
  });

  it('slow initialize with stderr heartbeat does NOT time out (activity resets idle timer)', async () => {
    // Fake-hermes prints a stderr heartbeat every 100ms while delaying the
    // initialize response by 4000ms — past the 3000ms idle timeout.
    // The stderr activity should reset the idle timer, so initialize succeeds.
    process.env['FAKE_HERMES_SLOW_INIT_MS'] = '4000';
    process.env['FAKE_HERMES_INIT_HEARTBEAT'] = '1';

    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });

    // Should reach `models` (signals session/new done) rather than error.
    await collectEvents(runId, (ev) => ev.type === 'models');

    delete process.env['FAKE_HERMES_SLOW_INIT_MS'];
    delete process.env['FAKE_HERMES_INIT_HEARTBEAT'];
  });

  it('hermes def uses generous cold-start timeouts', () => {
    const def = getAgentDef('hermes')!;
    // 60s handshake idle (raised from 15s). session/new's final step — building
    // `availableModels` — is a SILENT network fetch of the provider model list;
    // a cold first run over a slow/CN line exceeds 15s and false-times-out a
    // healthy hermes ("ACP idle timeout: session/new"). 60s covers the cold
    // build while the activity-reset idle timer still catches a true hang. See
    // the silent-tail tests below and the hermes.ts idleTimeoutMs comment.
    assert.equal(def.acp?.idleTimeoutMs, 60000);
    // 5min prompt idle — accommodates long-running tool calls (OCR, doc
    // conversion) where hermes itself is silent while a subprocess runs.
    assert.equal(def.acp?.promptIdleTimeoutMs, 300000);
    assert.equal(def.acp?.absoluteTimeoutMs, 1800000);
    assert.equal(def.acp?.cancelTimeoutMs, 5000);
  });

  it('session/new silent tail exceeding the idle budget times out naming session/new', async () => {
    // Reproduces the reporter's bug (2026-10-05). The tail of session/new
    // enumerates `availableModels` via a network fetch of the provider model
    // list and prints NOTHING to stderr. On a cold first run over a slow/CN
    // line that silent tail exceeds the handshake idle budget, so the handshake
    // fails with "ACP idle timeout: session/new" even though hermes is healthy
    // and about to respond. Harness sets MOLIO_ACP_IDLE_TIMEOUT_MS=3000; a
    // 4000ms silent session/new therefore trips it. The fix raises the real
    // budget to 60s (config test above) so the cold fetch fits; this test pins
    // the failure mode the fix addresses.
    process.env['FAKE_HERMES_SLOW_SESSION_NEW_MS'] = '4000';
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout test timed out')), 8000);
      const unsub = runManager.onEvent(runId, (ev) => {
        if (ev.type === 'error' && /idle timeout: session\/new/.test(ev.message)) {
          clearTimeout(timer);
          unsub?.();
          resolve();
        }
      });
      if (!unsub) {
        clearTimeout(timer);
        reject(new Error(`run ${runId} not found`));
      }
    });

    delete process.env['FAKE_HERMES_SLOW_SESSION_NEW_MS'];
  });

  it('session/new silent tail under the idle budget succeeds WITHOUT a heartbeat', async () => {
    // Complement to the test above: a silent session/new tail is only fatal when
    // it EXCEEDS the idle budget. Under it, the handshake completes with zero
    // stderr activity — no heartbeat required (unlike the initialize-heartbeat
    // test). This is exactly why raising idleTimeoutMs fixes the cold-start
    // false-positive: the model-list fetch is silent but finite, so a large
    // enough budget lets a healthy session/new through. Harness idle=3000ms; a
    // 200ms silent delay stays under it.
    process.env['FAKE_HERMES_SLOW_SESSION_NEW_MS'] = '200';
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });

    const events = await collectEvents(runId, (ev) => ev.type === 'models');
    assert.ok(
      events.some((e) => e.type === 'models'),
      'a silent-but-fast session/new should complete and emit the models event',
    );

    runManager.cancelRun(runId);
    delete process.env['FAKE_HERMES_SLOW_SESSION_NEW_MS'];
  });

  it('process exit before session/new rejects init promise and fails run', async () => {
    process.env['FAKE_HERMES_EXIT_AFTER_INIT'] = '1';
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });

    await waitForStatus(runId, 'failed');
    delete process.env['FAKE_HERMES_EXIT_AFTER_INIT'];
  });

  it('submitToolResult throws on ACP transport (Hermes runs tools internally)', async () => {
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    await collectEvents(runId, (ev) => ev.type === 'models');

    assert.throws(
      () => runManager.submitToolResult(runId, 'tc-1', 'result'),
      /ACP transport does not support host tool results/,
    );
  });

  it('prompt idle timeout surfaces last stderr line and persists INFO logs', async () => {
    // Reproduces the reporter scenario: hermes-acp prints a few INFO stderr
    // lines during session/prompt (provider connection), then goes totally
    // silent. The idle timer fires after MOLIO_ACP_PROMPT_IDLE_TIMEOUT_MS.
    //
    // Verifies two diagnostic fixes (now on the pool, which owns the shared
    // process's stderr — classifyAcpStderrLine + entry-level lastStderrLine):
    //  (a) INFO stderr lines are emitted as `raw` events (not dropped) so
    //      they land in events.jsonl for reporters to share.
    //  (b) The timeout error message includes `last stderr: "..."` so a
    //      screenshot of the chat error is enough to diagnose, no log file
    //      needed. The prompt timeout is session-scoped, so the process (and
    //      its stderr buffer) is still alive when the message is built.
    process.env['MOLIO_ACP_PROMPT_IDLE_TIMEOUT_MS'] = '500';
    process.env['FAKE_HERMES_PROMPT_HANG_WITH_STDERR'] = '1';

    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    await collectEvents(runId, (ev) => ev.type === 'models');

    // Collect raw + error events through the idle-timeout window.
    const rawLines: string[] = [];
    let errorEvent: Extract<AgentEvent, { type: 'error' }> | null = null;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test timed out waiting for prompt-idle error')), 5000);
      const unsub = runManager.onEvent(runId, (ev) => {
        if (ev.type === 'raw') rawLines.push((ev as Extract<AgentEvent, { type: 'raw' }>).line);
        if (ev.type === 'error' && ev.message.includes('prompt failed')) {
          errorEvent = ev as Extract<AgentEvent, { type: 'error' }>;
          clearTimeout(timer);
          unsub?.();
          resolve();
        }
      });
      if (!unsub) {
        clearTimeout(timer);
        reject(new Error(`run ${runId} not found`));
      }
    });

    // (a) INFO stderr lines should be captured as raw events
    assert.ok(
      rawLines.some((l) => l.includes('selected model qwen3.7-max')),
      `expected INFO line about model selection in raw events, got: ${JSON.stringify(rawLines)}`,
    );
    assert.ok(
      rawLines.some((l) => l.includes('connecting to https://api.example.com')),
      `expected INFO line about provider connection in raw events, got: ${JSON.stringify(rawLines)}`,
    );

    // (b) Error message should include the last stderr line
    assert.ok(errorEvent, 'expected an error event for prompt-idle timeout');
    const errMsg = (errorEvent as Extract<AgentEvent, { type: 'error' }>)?.message ?? '';
    assert.match(errMsg, /prompt failed: ACP idle timeout: session\/prompt/);
    assert.match(errMsg, /last stderr:.*waiting for first token/);

    delete process.env['MOLIO_ACP_PROMPT_IDLE_TIMEOUT_MS'];
    delete process.env['FAKE_HERMES_PROMPT_HANG_WITH_STDERR'];
  });
});
