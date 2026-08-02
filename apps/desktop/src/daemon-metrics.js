/**
 * Periodically polls the daemon `/api/health` endpoint and reports memory
 * metrics to ARMS via `sendCustom`. This is the only path for daemon memory
 * data to reach ARMS — the daemon has no ARMS SDK of its own.
 *
 * Polling interval: 60 seconds (configurable via MOLIO_DAEMON_METRICS_INTERVAL_MS).
 * This is intentionally more frequent than the ARMS memory collector's 30-minute
 * window — we need finer granularity for the daemon because it spawns child
 * processes that can balloon memory quickly.
 *
 * Uses console.log (stdout) for diagnostic output, NOT console.warn/error
 * (stderr). Cloud log collectors classify stderr as ERROR.
 */

const DEFAULT_INTERVAL_MS = 60_000;
// Guard against a misconfigured (tiny) interval flooding the daemon with health
// requests and ARMS with duplicate metrics. setInterval clamps values <= 0 to
// 1ms, which would fire the callback thousands of times per second.
const MIN_INTERVAL_MS = 1_000;

/**
 * Resolve the polling interval from a raw env var value.
 *
 * A negative or zero value is truthy in JS, so a naive `Number(x) || fallback`
 * would let e.g. `-1` through — and `setInterval(fn, -1)` clamps to 1ms,
 * flooding the daemon. Require a finite value at or above MIN_INTERVAL_MS,
 * otherwise fall back to the default.
 *
 * @param {string | undefined} rawValue
 * @returns {number} interval in milliseconds
 */
export function resolveIntervalMs(rawValue) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Start polling daemon health and reporting to ARMS.
 *
 * @param {{ armsRum: object|null, daemonPort?: number, log: Function, intervalMs?: number }} opts
 *   `intervalMs` overrides the env-derived interval; intended for tests so they
 *   can poll faster than the MIN_INTERVAL_MS production floor.
 * @returns {() => void} stop function
 */
export function startDaemonMetricsPolling({ armsRum, daemonPort = 3100, log, intervalMs }) {
  const effectiveInterval = intervalMs ?? resolveIntervalMs(process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS);
  const url = `http://localhost:${daemonPort}/api/health`;

  const timer = setInterval(async () => {
    if (!armsRum) return;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const health = await res.json();
      if (!health.memory) return;

      const mem = health.memory;
      armsRum.sendCustom({
        type: 'daemon_memory',
        name: 'health_poll',
        value: mem.rss,
        group: 'daemon',
        properties: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
          activeRuns: health.activeRuns ?? 0,
          uptime: health.uptime ?? 0,
        },
      });
    } catch {
      // Daemon unreachable (down or restarting) — skip silently.
      // Do NOT use console.error: cloud log collectors classify stderr as ERROR.
    }
  }, effectiveInterval);

  // Do not prevent process exit.
  timer.unref();

  log('info', 'daemon-metrics', `polling ${url} every ${effectiveInterval / 1000}s`);

  return () => {
    clearInterval(timer);
  };
}
