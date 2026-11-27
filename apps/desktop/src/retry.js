/**
 * Retry/backoff logic for the auto-updater.
 *
 * Extracted as a pure module (no Electron dependencies) so it can be
 * unit-tested in plain Node.js without any mocking.
 */

/** Backoff delays in ms: 30s → 1m → 2m → 5m → 15m */
export const RETRY_DELAYS = [30_000, 60_000, 120_000, 300_000, 900_000];

/**
 * Get the next retry delay for a given attempt index.
 * After exhausting all delays, stays at the last value.
 *
 * @param {number} attempt — 0-based attempt index
 * @returns {number} delay in milliseconds
 */
export function getRetryDelay(attempt) {
  if (attempt < 0) return RETRY_DELAYS[0];
  const idx = Math.min(attempt, RETRY_DELAYS.length - 1);
  return RETRY_DELAYS[idx];
}

/**
 * Create a new retry state tracker.
 * Each call to `.next()` returns the delay and advances the counter.
 * `.reset()` resets the counter (e.g. after a successful check).
 */
export function createRetryState() {
  let index = 0;

  return {
    /** Get the current attempt (0-based) */
    get attempt() {
      return index;
    },

    /** Get next delay and advance the counter */
    next() {
      const delay = getRetryDelay(index);
      index++;
      return delay;
    },

    /** Reset counter after a successful check */
    reset() {
      index = 0;
    },
  };
}
