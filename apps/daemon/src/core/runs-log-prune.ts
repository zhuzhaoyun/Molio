import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Pruning for per-run JSONL event logs under ~/.molio/runs/.
 *
 * Every run writes its event stream to ~/.molio/runs/<runId>/events.jsonl
 * (RunManager.ensureLogStream). finishRun closes the stream but nothing ever
 * deleted the files — ~2000 run directories (72MB) had accumulated on a real
 * machine after five weeks. Prune once at daemon startup; the window is wide
 * (7 days) so logs from recent debugging sessions survive.
 *
 * Age is judged from the directory's mtime: it updates when entries are
 * created or removed inside (i.e. while a run is active), so a directory
 * untouched for maxAgeDays belongs to a long-finished run.
 */

export const DEFAULT_RUNS_LOG_DIR = path.join(os.homedir(), '.molio', 'runs');
export const DEFAULT_MAX_AGE_DAYS = 7;

export interface PruneRunLogsOptions {
  /** Directory to prune. Default: ~/.molio/runs */
  dir?: string;
  /** Delete directories whose mtime is older than this. Default: 7 days. */
  maxAgeDays?: number;
  /** Reference time (for tests). Default: Date.now(). */
  now?: number;
}

export interface PruneRunLogsResult {
  removed: number;
  failed: number;
  kept: number;
}

export function pruneRunLogs(opts: PruneRunLogsOptions = {}): PruneRunLogsResult {
  const dir = opts.dir ?? DEFAULT_RUNS_LOG_DIR;
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;

  const result: PruneRunLogsResult = { removed: 0, failed: 0, kept: 0 };

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Directory doesn't exist yet (fresh install) — nothing to do.
    return result;
  }

  for (const name of entries) {
    const target = path.join(dir, name);
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) {
        result.kept++;
        continue;
      }
      if (now - st.mtimeMs <= maxAgeMs) {
        result.kept++;
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
      result.removed++;
    } catch {
      // A locked or vanished directory must never abort the sweep.
      result.failed++;
    }
  }

  if (result.removed > 0) {
    console.log(
      `[runs-log-prune] removed ${result.removed} expired run log directories ` +
      `(kept ${result.kept}, failed ${result.failed}) from ${dir}`,
    );
  }
  return result;
}
