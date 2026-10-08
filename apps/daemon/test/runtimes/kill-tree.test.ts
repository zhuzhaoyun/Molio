import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killAgentProcessTree } from '../../src/core/runtimes/kill-tree.js';

/**
 * Error-driven regression test (Windows orphan leak, 2026-10-05).
 *
 * RunManager spawns `.cmd`-shimmed agents with `shell: true`, so the
 * ChildProcess it holds is a `cmd.exe` wrapper and the real agent (`node …`) is
 * a GRANDCHILD. The old cancel path called `child.kill('SIGTERM')`, which on
 * Windows is TerminateProcess on the wrapper ONLY — the node grandchild was
 * orphaned and kept running. Over a full test suite these orphans piled up,
 * exhausted handles/process slots, and made later spawns (e.g. the dsh route
 * test's live version probe) fail spuriously → "dsh is not installed".
 *
 * `killAgentProcessTree` uses `taskkill /pid <pid> /T /F` to reap the whole
 * tree. This test spawns a real cmd→node tree, kills it via the wrapper, and
 * asserts the GRANDCHILD dies — which it would NOT under the old child.kill().
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

/** Signal 0 probes process existence without actually signaling it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('killAgentProcessTree — Windows orphan-leak regression', () => {
  let child: ChildProcess | null = null;
  let dir = '';

  afterEach(() => {
    if (child) {
      // Best-effort cleanup; on Windows the tree-kill already reaped it.
      killAgentProcessTree(child);
      child = null;
    }
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      dir = '';
    }
  });

  // The orphaned-grandchild bug is Windows-specific: it comes from the
  // `cmd.exe` shell wrapper that `.cmd` shims require. On POSIX the spawned
  // child IS the agent (no wrapper), so there is no grandchild to orphan and
  // the SIGTERM→SIGKILL path is unchanged. Gate the live-process test to Win.
  const itWin = process.platform === 'win32' ? it : it.skip;

  itWin("reaps the cmd.exe wrapper's node grandchild (not just the wrapper)", async () => {
    dir = mkdtempSync(join(tmpdir(), 'killtree-'));
    const pidfile = join(dir, 'grandchild.pid');
    const cmd = join(process.cwd(), 'test/fixtures/fake-agents/tree-parent.cmd');

    child = spawn(cmd, [], {
      shell: true,
      windowsHide: true,
      env: { ...process.env, TREE_CHILD_PIDFILE: pidfile },
    });

    // Wait for the grandchild to boot and publish its pid.
    const started = await waitFor(() => existsSync(pidfile), 8000);
    assert.ok(started, 'grandchild must start and write its pidfile');
    const gpid = Number(readFileSync(pidfile, 'utf8').trim());
    assert.ok(
      Number.isFinite(gpid) && gpid > 0,
      `grandchild pid must be a valid positive integer, got ${gpid}`,
    );
    assert.ok(isAlive(gpid), 'grandchild must be alive before the kill');

    // Kill via the WRAPPER's ChildProcess — exactly what cancelRun holds.
    killAgentProcessTree(child);

    // The decisive assertion: the grandchild must be reaped. Under the old
    // child.kill('SIGTERM') the cmd.exe wrapper died but this node survived.
    const reaped = await waitFor(() => !isAlive(gpid), 8000);
    assert.ok(
      reaped,
      `grandchild ${gpid} must be reaped by tree-kill (Windows orphan-leak regression)`,
    );
  });
});
