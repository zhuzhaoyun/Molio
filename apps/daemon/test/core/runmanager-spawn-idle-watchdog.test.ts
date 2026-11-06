/**
 * Error-driven integration tests: spawn-path idle watchdog (2026-10-22).
 *
 * Incident: a wiki-ingest run on qwen3.8-max (claude CLI spawn path) hung on a
 * dead provider request — child process alive at ~0% CPU, zero stdout for 20+
 * minutes. The ACP path has transport-level promptIdle/absolute timeouts, but
 * the stdio-jsonl spawn path had NONE: the run stayed 'running' forever, the
 * web UI only escaped via its own 10-min client-side fallback, and channel
 * dispatchers (weixin/feishu) would keep the zombie run occupying the queue.
 *
 * Fix: RunManager arms a phase-aware idle watchdog on spawn-path runs —
 *   - model phase (no pending tool_use): MOLIO_SPAWN_IDLE_TIMEOUT_MS (10 min)
 *   - tool phase (tool_use awaiting tool_result): MOLIO_SPAWN_TOOL_IDLE_MS
 *     (30 min) — covers silent long-running Bash/MCP/subagent tools
 *   - EVERY emitted event re-arms the countdown (active runs never false-fire)
 *   - disarmed while waiting for a host answer (AskUserQuestion — unbounded
 *     human wait) and between turns of multiTurn agents (weixin queue reuse)
 *   - on fire: descriptive error event → finishRun(failed) → tree-kill child
 *
 * These tests drive REAL RunManager.createRun against the fake-claude fixture
 * (behavior mock, per the repo's integration-test rules) with timeouts shrunk
 * via env so each case runs in seconds.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '@molio/contracts';
import { RunManager } from '../../src/core/RunManager.js';

const fakeClaudePath = join(
  process.cwd(),
  'test/fixtures/fake-agents',
  process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.mjs',
);

const ENV_KEYS = [
  'CLAUDE_BIN', 'MOLIO_DATA_DIR',
  'FAKE_CLAUDE_SILENT_HANG', 'FAKE_CLAUDE_HANG_IN_TOOL', 'FAKE_CLAUDE_ASK_WAIT',
  'FAKE_CLAUDE_MULTI_TURN', 'FAKE_CLAUDE_DRIP_MS', 'FAKE_CLAUDE_DRIP_COUNT',
  'MOLIO_SPAWN_IDLE_TIMEOUT_MS', 'MOLIO_SPAWN_TOOL_IDLE_TIMEOUT_MS',
];

/** Poll `pred` until truthy; throw after timeoutMs. */
async function waitFor(
  pred: () => unknown,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('RunManager spawn-path idle watchdog', () => {
  let runManager: RunManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-idle-watchdog-'));
    process.env['MOLIO_DATA_DIR'] = tempDir;
    process.env['CLAUDE_BIN'] = fakeClaudePath;
    runManager = new RunManager();
  });

  afterEach(() => {
    runManager.cancelAll('test:cleanup');
    rmSync(tempDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) delete process.env[k];
  });

  function events(runId: string): AgentEvent[] {
    return (runManager.getBufferedEvents(runId) ?? []).map((e) => e.data as AgentEvent);
  }
  function errorEvents(runId: string): string[] {
    return events(runId)
      .filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
      .map((e) => e.message);
  }
  function turnEnds(runId: string): string[] {
    return events(runId)
      .filter((e): e is Extract<AgentEvent, { type: 'turn_end' }> => e.type === 'turn_end')
      .map((e) => e.stopReason);
  }
  function textOf(runId: string): string {
    return events(runId)
      .filter((e): e is Extract<AgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
  }

  it('model-phase hang: silent child is failed with a descriptive error and tree-killed', async () => {
    process.env['FAKE_CLAUDE_SILENT_HANG'] = '1';
    process.env['MOLIO_SPAWN_IDLE_TIMEOUT_MS'] = '1000';
    process.env['MOLIO_SPAWN_TOOL_IDLE_TIMEOUT_MS'] = '60000';

    const runId = await runManager.createRun({ agentId: 'claude', message: 'hi' });
    const child = (runManager as any).runs.get(runId)?.child;
    assert.ok(child?.pid, 'child process should have been spawned');

    await waitFor(
      () => runManager.getRunInfo(runId)?.status === 'failed',
      15_000,
      'run to be failed by the idle watchdog',
    );

    const errors = errorEvents(runId);
    assert.ok(
      errors.some((m) => m.includes('模型无响应') && m.includes('模型生成')),
      `expected a model-phase idle error, got: ${JSON.stringify(errors)}`,
    );
    assert.match(runManager.getRunInfo(runId)?.error ?? '', /模型无响应/);

    // The hung child must be reaped — a silent-hang fixture never exits on its
    // own, so a non-null exitCode/signalCode proves the watchdog killed it.
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      15_000,
      'hung child process to be killed',
    );
  });

  it('tool-phase hang: pending tool_use gets the LONGER tool budget, not the model one', async () => {
    process.env['FAKE_CLAUDE_HANG_IN_TOOL'] = '1';
    process.env['MOLIO_SPAWN_IDLE_TIMEOUT_MS'] = '1000';
    process.env['MOLIO_SPAWN_TOOL_IDLE_TIMEOUT_MS'] = '2500';

    const t0 = Date.now();
    const runId = await runManager.createRun({ agentId: 'claude', message: 'hi' });

    await waitFor(
      () => runManager.getRunInfo(runId)?.status === 'failed',
      20_000,
      'run to be failed by the tool-phase idle watchdog',
    );
    const elapsed = Date.now() - t0;

    // Must have waited for the TOOL budget — firing at the 1000ms model budget
    // would kill legitimate silent Bash calls (they cap at 10 min in real CC).
    assert.ok(elapsed >= 2400, `fired too early (${elapsed}ms) — model budget used for tool phase?`);
    const errors = errorEvents(runId);
    assert.ok(
      errors.some((m) => m.includes('模型无响应') && m.includes('工具执行')),
      `expected a tool-phase idle error, got: ${JSON.stringify(errors)}`,
    );
  });

  it('active run: continuous output re-arms the countdown and never false-fires', async () => {
    // Drips a text delta every 150ms for ~1.5s — total run duration EXCEEDS the
    // 1000ms idle budget, so only per-event re-arming keeps the run alive.
    process.env['FAKE_CLAUDE_DRIP_MS'] = '150';
    process.env['FAKE_CLAUDE_DRIP_COUNT'] = '10';
    process.env['MOLIO_SPAWN_IDLE_TIMEOUT_MS'] = '1000';
    process.env['MOLIO_SPAWN_TOOL_IDLE_TIMEOUT_MS'] = '60000';

    const runId = await runManager.createRun({ agentId: 'claude', message: 'hi' });

    await waitFor(
      () => {
        const s = runManager.getRunInfo(runId)?.status;
        return s === 'succeeded' || s === 'failed';
      },
      20_000,
      'dripping run to finish',
    );

    assert.equal(runManager.getRunInfo(runId)?.status, 'succeeded');
    assert.deepEqual(errorEvents(runId), [], 'no watchdog error on an active run');
    assert.ok(textOf(runId).includes('drip10'), 'all deltas streamed through');
  });

  it('multiTurn: watchdog disarms at turn_end (unbounded wait for next user message) and re-arms on sendMessage', async () => {
    process.env['FAKE_CLAUDE_MULTI_TURN'] = '1';
    process.env['MOLIO_SPAWN_IDLE_TIMEOUT_MS'] = '1000';
    process.env['MOLIO_SPAWN_TOOL_IDLE_TIMEOUT_MS'] = '60000';

    const runId = await runManager.createRun({ agentId: 'claude', message: 'hi' });
    await waitFor(() => turnEnds(runId).length >= 1, 15_000, 'first turn_end');

    // Between turns the run waits for the NEXT user message (weixin queue /
    // desktop follow-up) — 2× the idle budget of silence must NOT kill it.
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(runManager.getRunInfo(runId)?.status, 'running');
    assert.deepEqual(errorEvents(runId), [], 'idle-between-turns must not error');

    // sendMessage starts a new turn → watchdog re-armed → reply arrives.
    runManager.sendMessage(runId, 'again');
    await waitFor(() => textOf(runId).includes('Reply #2'), 15_000, 'second reply');
    assert.equal(runManager.getRunInfo(runId)?.status, 'running');
    assert.deepEqual(errorEvents(runId), []);
  });

  it('AskUserQuestion: unbounded wait for a human answer never fires, and submitToolResult resumes the turn', async () => {
    process.env['FAKE_CLAUDE_ASK_WAIT'] = '1';
    process.env['MOLIO_SPAWN_IDLE_TIMEOUT_MS'] = '1000';
    // Tool budget shorter than the test sleep: without the host-answer disarm,
    // the pending AskUserQuestion tool_use would be killed at 1500ms.
    process.env['MOLIO_SPAWN_TOOL_IDLE_TIMEOUT_MS'] = '1500';

    const runId = await runManager.createRun({ agentId: 'claude', message: 'hi' });
    await waitFor(
      () => events(runId).some((e) => e.type === 'tool_use' && (e as any).name === 'AskUserQuestion'),
      15_000,
      'AskUserQuestion tool_use',
    );

    // Human "thinks overnight" — 2.5s of silence here stands in for hours.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(runManager.getRunInfo(runId)?.status, 'running');
    assert.deepEqual(errorEvents(runId), [], 'host-answer wait must not trip the watchdog');

    runManager.submitToolResult(runId, 'toolu_ask', 'proceed');
    await waitFor(() => textOf(runId).includes('Thanks for answering!'), 15_000, 'resumed reply');
    assert.deepEqual(errorEvents(runId), []);
  });
});
