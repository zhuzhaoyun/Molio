import { execFileSync, type ChildProcess } from 'node:child_process';

/**
 * Kill an agent child process — and on Windows, its ENTIRE process tree.
 *
 * Why this exists (orphan-leak root cause, 2026-10-05):
 * On Windows, `.cmd`/`.bat` shims (and extensionless POSIX shims) must be
 * spawned with `shell: true` (see launch.ts:needsShellOnWindows). That makes
 * the `ChildProcess` we hold a `cmd.exe` wrapper, and the REAL agent CLI
 * (`node …`, the actual binary) a GRANDCHILD. `child.kill()` on Windows is
 * `TerminateProcess` on the direct child only — it reaps `cmd.exe` and ORPHANS
 * the grandchild, which keeps running (blocked on stdin) indefinitely.
 *
 * The leak is cumulative: over a long daemon session — or a single full test
 * suite that spawns+cancels many fake agents — the orphaned `node` processes
 * pile up, exhaust handles / process slots, and later `spawn()` calls start
 * failing spuriously (EMFILE/EAGAIN). In CI that surfaced as the dsh route
 * test's live version-probe failing FAST (~1s, not the 5s probe timeout) →
 * "dsh is not installed" → a confusing early-return. `taskkill /pid <pid> /T /F`
 * walks the tree from the wrapper down and reaps everything.
 *
 * POSIX delivers the signal straight to the child (no `cmd.exe` wrapper sits in
 * between), so the graceful `SIGTERM → 5s → SIGKILL` escalation is preserved
 * there — this function is a no-op change on Linux/macOS behavior.
 *
 * Distinct from preload-manager's internal `killProcessTree`: that one relies on
 * `detached: true` (POSIX process-group `kill(-pid)`), which RunManager does NOT
 * use for agent children. This variant signals the direct child on POSIX and
 * tree-kills on Windows, matching how RunManager spawns agents.
 */
export function killAgentProcessTree(child: ChildProcess | null | undefined): void {
  if (!child || child.killed || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    if (child.pid) {
      try {
        // /T = kill the whole tree, /F = force. stdio ignored + windowsHide so
        // taskkill never flashes a console or pollutes the daemon's streams.
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
        });
        return;
      } catch {
        // taskkill failed (process already gone / access denied) — fall through
        // to a direct kill so we still make a best effort on the wrapper.
      }
    }
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    return;
  }

  // POSIX: graceful term, then escalate to kill if it lingers.
  try { child.kill('SIGTERM'); } catch { /* already dead */ }
  setTimeout(() => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 5000);
}
