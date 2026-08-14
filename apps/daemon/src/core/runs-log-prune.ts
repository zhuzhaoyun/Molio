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

/** Decide and act on a single entry. Shared by the sync and async sweeps. */
function pruneEntry(
  dir: string,
  name: string,
  now: number,
  maxAgeMs: number,
  result: PruneRunLogsResult,
): void {
  const target = path.join(dir, name);
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) {
      result.kept++;
      return;
    }
    if (now - st.mtimeMs <= maxAgeMs) {
      result.kept++;
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
    result.removed++;
  } catch {
    // A locked or vanished directory must never abort the sweep.
    result.failed++;
  }
}

function logPruneSummary(result: PruneRunLogsResult, dir: string): void {
  // Log on failures too: if every expired dir is locked (EACCES / Windows file
  // locks) nothing is removed and the disk fills up silently — the startup
  // caller discards the result, so this line is the only diagnostic.
  if (result.removed > 0 || result.failed > 0) {
    const logFn = result.failed > 0 ? console.warn : console.log;
    logFn(
      `[runs-log-prune] removed ${result.removed} expired run log directories ` +
      `(kept ${result.kept}, failed ${result.failed}) from ${dir}`,
    );
  }
}

/**
 * Read the prune dir's entries. Returns null when the dir is missing (fresh
 * install — nothing to do, silent); logs and returns null on any OTHER error
 * (an unreadable ~/.molio/runs must be diagnosable, not silently "empty").
 */
function readPruneEntries(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[runs-log-prune] cannot read ${dir}:`, err instanceof Error ? err.message : err);
    }
    return null;
  }
}

export function pruneRunLogs(opts: PruneRunLogsOptions = {}): PruneRunLogsResult {
  const dir = opts.dir ?? DEFAULT_RUNS_LOG_DIR;
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;

  const result: PruneRunLogsResult = { removed: 0, failed: 0, kept: 0 };

  const entries = readPruneEntries(dir);
  if (!entries) return result;

  for (const name of entries) {
    pruneEntry(dir, name, now, maxAgeMs, result);
  }

  logPruneSummary(result, dir);
  return result;
}

/**
 * Entries processed before yielding to the event loop in pruneRunLogsAsync.
 * A real machine had ~600 run dirs; stat+rm over all of them took ~4s of
 * straight event-loop blocking on a cold disk cache.
 */
const ASYNC_CHUNK_SIZE = 64;

/**
 * Async variant of pruneRunLogs for daemon startup: identical semantics, but
 * yields to the event loop every ASYNC_CHUNK_SIZE entries so the sweep cannot
 * starve HTTP handling (it runs right after the server starts listening).
 */
export async function pruneRunLogsAsync(
  opts: PruneRunLogsOptions = {},
): Promise<PruneRunLogsResult> {
  const dir = opts.dir ?? DEFAULT_RUNS_LOG_DIR;
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;

  const result: PruneRunLogsResult = { removed: 0, failed: 0, kept: 0 };

  const entries = readPruneEntries(dir);
  if (!entries) return result;

  let processed = 0;
  for (const name of entries) {
    pruneEntry(dir, name, now, maxAgeMs, result);
    processed++;
    if (processed % ASYNC_CHUNK_SIZE === 0 && processed < entries.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  logPruneSummary(result, dir);
  return result;
}
