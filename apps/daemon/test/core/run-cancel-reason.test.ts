/**
 * Regression tests for cancel observability (2026-09-28).
 *
 * A cancelled run used to leave no trace at all: `cancelRun` logged nothing and
 * `DELETE /api/runs/:id` logged nothing, so during an investigation into "the
 * reply I was watching disappeared" it was impossible to tell whether the user
 * hit 停止, a channel timed out, or something cancelled on its own — the
 * events.jsonl only records the resulting `status: canceled` event.
 *
 * Every cancel now logs `run=`, `reason=` (a short caller tag) and the status it
 * transitioned from.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RunManager } from '../../src/core/RunManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeClaudePath = join(
  process.cwd(),
  'test/fixtures/fake-agents',
  process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.mjs',
);

describe('RunManager.cancelRun — cancel reasons are logged', () => {
  let runManager: RunManager;
  let tempDir: string;
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-cancel-reason-'));
    process.env['MOLIO_DATA_DIR'] = tempDir;
    process.env['CLAUDE_BIN'] = fakeClaudePath;
    // Keep the child alive with no turn_end: the run stays cancellable instead
    // of finishing on its own before the cancel lands.
    process.env['FAKE_CLAUDE_NO_TURN_END'] = '1';
    runManager = new RunManager();
    logs = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map((a) => String(a)).join(' ')); };
  });

  afterEach(() => {
    console.log = origLog;
    runManager.cancelAll('test:cleanup');
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['CLAUDE_BIN'];
    delete process.env['FAKE_CLAUDE_NO_TURN_END'];
    delete process.env['MOLIO_DATA_DIR'];
  });

  const cancelLogs = () => logs.filter((l) => l.includes('[runs] cancel'));

  async function startRun(): Promise<string> {
    return runManager.createRun({
      agentId: 'claude',
      message: 'stay alive',
      onTurnComplete: () => { /* keep streaming */ },
    });
  }

  it('logs run id, caller tag and the status it left', async () => {
    const runId = await startRun();
    logs = [];

    runManager.cancelRun(runId, 'api:delete-run');

    const cancels = cancelLogs();
    assert.equal(cancels.length, 1, `expected exactly one cancel log, got: ${JSON.stringify(logs)}`);
    assert.match(cancels[0]!, new RegExp(`cancel run=${runId}`));
    assert.match(cancels[0]!, /reason=api:delete-run/);
    assert.match(cancels[0]!, /status=running/);
    assert.doesNotMatch(cancels[0]!, /no-op/);
  });

  it('marks a repeat cancel as a no-op instead of a second transition', async () => {
    const runId = await startRun();
    runManager.cancelRun(runId, 'api:delete-run');
    logs = [];

    runManager.cancelRun(runId, 'api:delete-run');

    assert.match(cancelLogs()[0]!, /no-op/);
  });

  it('records a cancel for an unknown run instead of returning silently', () => {
    runManager.cancelRun('does-not-exist', 'api:delete-run');

    assert.match(cancelLogs()[0]!, /cancel ignored run=does-not-exist/);
    assert.match(cancelLogs()[0]!, /unknown run/);
  });

  it('propagates the reason through cancelAll to every run', async () => {
    const first = await startRun();
    const second = await startRun();
    logs = [];

    runManager.cancelAll('shutdown:graceful');

    const cancels = cancelLogs();
    assert.equal(cancels.length, 2);
    for (const id of [first, second]) {
      assert.ok(
        cancels.some((l) => l.includes(`run=${id}`) && l.includes('reason=shutdown:graceful')),
        `missing cancel log for ${id}: ${JSON.stringify(cancels)}`,
      );
    }
  });

  it('defaults to an explicit "unspecified" tag rather than an empty reason', async () => {
    const runId = await startRun();
    logs = [];

    runManager.cancelRun(runId);

    assert.match(cancelLogs()[0]!, /reason=unspecified/);
  });
});
