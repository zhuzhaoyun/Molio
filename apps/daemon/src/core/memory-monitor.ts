import { dbgLog } from './debug-log.js';
import { ThrottledWarn } from './throttled-warn.js';

/**
 * Periodic memory sampler for the daemon process.
 *
 * Samples `process.memoryUsage()` every 60 seconds and logs a one-line
 * summary via `dbgLog` (stdout + `~/.molio/debug/sse-debug.log`). When RSS
 * exceeds a threshold (default 1 GB), emits a throttled warning — at most
 * once per 5 minutes — so the log stays useful without flooding.
 *
 * All output goes through `dbgLog` → `console.log` (stdout), NEVER
 * `console.warn`/`console.error` (stderr). Cloud log collectors (SLS) classify
 * stderr as ERROR level; routine memory diagnostics must not create false
 * positives in ARMS 异常统计.
 *
 * The threshold is deliberately high: the daemon with 2–3 active runs each
 * spawning a CLI process can legitimately use 500 MB+. 1 GB is the point
 * where we want to start asking questions.
 *
 * Usage:
 * ```ts
 * const stop = startMemoryMonitor({ getContext: () => `activeRuns=${rm.getActiveRunCount()}` });
 * // later…
 * stop();
 * ```
 */

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLD_MB = 1024;

const MB = 1024 * 1024;

export interface MemoryMonitorOptions {
  /** Sampling interval in ms. Default: 60 000. */
  intervalMs?: number;
  /** RSS threshold in MB for the throttled warning. Default: 1024. */
  thresholdMB?: number;
  /** Optional callback returning extra context (e.g. active run count). */
  getContext?: () => string;
}

export function startMemoryMonitor(opts?: MemoryMonitorOptions): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdBytes = (opts?.thresholdMB ?? DEFAULT_THRESHOLD_MB) * MB;
  const getContext = opts?.getContext;

  const highMemWarn = new ThrottledWarn({ sink: (m) => dbgLog(m) });

  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const ctx = getContext ? ` ${getContext()}` : '';
    dbgLog(
      `[memory-monitor] rss=${Math.round(mem.rss / MB)}MB ` +
      `heapUsed=${Math.round(mem.heapUsed / MB)}MB ` +
      `heapTotal=${Math.round(mem.heapTotal / MB)}MB ` +
      `external=${Math.round(mem.external / MB)}MB ` +
      `uptime=${Math.floor(process.uptime())}s` +
      ctx,
    );

    if (mem.rss > thresholdBytes) {
      highMemWarn.warn(
        'high-rss',
        `[memory-monitor] HIGH RSS: ${Math.round(mem.rss / MB)}MB exceeds threshold ${Math.round(thresholdBytes / MB)}MB` + ctx,
      );
    }
  }, intervalMs);

  // Do not prevent the process from exiting.
  timer.unref();

  return () => {
    clearInterval(timer);
    highMemWarn.reset();
  };
}
