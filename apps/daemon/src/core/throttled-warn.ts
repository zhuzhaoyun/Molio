/**
 * Rate-limited warning emitter — the canonical implementation of the
 * "warn at most once per interval per key" pattern first introduced inline in
 * vault-prune.ts for the oversized-directory warning.
 *
 * Why this exists: several daemon warnings describe a *stable, expected*
 * condition (an oversized vault dir, a watcher that keeps erroring, a missing
 * skills source). The UI / agent loop re-triggers them many times a second, so
 * an un-throttled warning floods stderr — and cloud log collectors (Logtail /
 * SLS) classify every stderr line as an ERROR, turning a benign condition into
 * thousands of false anomalies.
 *
 * The fix: emit at most once per key per interval. Repeats inside the window
 * are counted and folded into the next emitted message, so the volume stays
 * visible ("suppressed N repeat warnings …") without flooding. The warning
 * still resurfaces periodically, so it is never permanently hidden.
 *
 * Kept dependency-free on purpose: importing it (e.g. from vault-prune or
 * vault-watcher) must NOT transitively load encoding.ts, because some tests
 * tune encoding's size caps via env vars at their own module-load time.
 */

/** Re-warn for the same key at most this often (matches the vault-prune cadence). */
export const DEFAULT_WARN_INTERVAL_MS = 5 * 60 * 1000;

export interface ThrottledWarnOptions {
  /** Minimum gap between emissions for a given key. Default 5 minutes. */
  intervalMs?: number;
  /**
   * Where the (already suffixed) message is written. Default `console.warn`.
   * Pass `dbgLog` to keep a diagnostic on the stdout + debug-file channel
   * instead of stderr.
   */
  sink?: (message: string) => void;
}

interface WarnState {
  lastAt: number;
  suppressed: number;
}

export class ThrottledWarn {
  private readonly state = new Map<string, WarnState>();
  private readonly intervalMs: number;
  private readonly sink: (message: string) => void;

  constructor(opts: ThrottledWarnOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_WARN_INTERVAL_MS;
    this.sink = opts.sink ?? ((message) => console.warn(message));
  }

  /**
   * Emit `message` for `key` at most once per interval. Repeats inside the
   * window are counted and reported in the next emitted message. `now` is
   * injectable for deterministic tests. Returns true if a message was emitted.
   */
  warn(key: string, message: string, now: number = Date.now()): boolean {
    const existing = this.state.get(key);
    if (existing && now - existing.lastAt < this.intervalMs) {
      existing.suppressed++;
      return false;
    }
    const suppressed = existing?.suppressed ?? 0;
    // The key set is naturally tiny (one entry per distinct condition ever
    // seen), so no eviction is needed.
    this.state.set(key, { lastAt: now, suppressed: 0 });
    const suffix = suppressed > 0
      ? ` (suppressed ${suppressed} repeat warning${suppressed === 1 ? '' : 's'} in the previous interval)`
      : '';
    this.sink(message + suffix);
    return true;
  }

  /** Clear throttle state — test hook so cases start from a clean slate. */
  reset(): void {
    this.state.clear();
  }
}
