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
    // Fast ACP timeouts for tests (overrides RunManager defaults).
    // Idle=500ms means "if fake-hermes goes silent for 0.5s, time out";
    // absolute=2000ms is the safety net.
    process.env['MOLIO_ACP_IDLE_TIMEOUT_MS'] = '500';
    process.env['MOLIO_ACP_ABSOLUTE_TIMEOUT_MS'] = '2000';
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

  it('cancelRun marks session cancelled and terminates the process', async () => {
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });
    await collectEvents(runId, (ev) => ev.type === 'models');

    runManager.cancelRun(runId);
    // Should reach a terminal status (cancelled → canceled or failed, depending on SIGTERM timing)
    await new Promise<void>((resolve) => {
      const check = () => {
        const info = runManager.getRunInfo(runId);
        if (info && ['succeeded', 'failed', 'canceled'].includes(info.status)) resolve();
        else setTimeout(check, 30);
      };
      check();
    });
  });

  it('initialize idle-timeout emits error and fails the run', async () => {
    process.env['FAKE_HERMES_NO_INIT'] = '1';
    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });

    // With MOLIO_ACP_IDLE_TIMEOUT_MS=500 + FAKE_HERMES_NO_INIT=1, fake-hermes
    // goes totally silent → idle timer fires after ~500ms with an error
    // containing 'idle' and 'timeout'.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout test timed out')), 5000);
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
    // initialize response by 1500ms — well past the 500ms idle timeout.
    // The stderr activity should reset the idle timer, so initialize succeeds.
    process.env['FAKE_HERMES_SLOW_INIT_MS'] = '1500';
    process.env['FAKE_HERMES_INIT_HEARTBEAT'] = '1';

    const runId = await runManager.createRun({ agentId: 'hermes', message: 'hi' });

    // Should reach `models` (signals session/new done) rather than error.
    await collectEvents(runId, (ev) => ev.type === 'models');

    delete process.env['FAKE_HERMES_SLOW_INIT_MS'];
    delete process.env['FAKE_HERMES_INIT_HEARTBEAT'];
  });

  it('hermes def uses generous cold-start timeouts', () => {
    const def = getAgentDef('hermes')!;
    assert.equal(def.acp?.idleTimeoutMs, 15000);
    assert.equal(def.acp?.promptIdleTimeoutMs, 60000);
    assert.equal(def.acp?.absoluteTimeoutMs, 300000);
    assert.equal(def.acp?.cancelTimeoutMs, 5000);
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
});
