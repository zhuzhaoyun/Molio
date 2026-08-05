/**
 * Fixed-capacity ring buffer for recent lines.
 *
 * main.js uses this to hold daemon stdout/stderr lines for exit-time
 * diagnostics. The previous implementation used a plain array that pushed
 * every line forever — after a day of runtime, a full day of daemon output
 * accumulated in the Electron main process's memory (part of the 3GB
 * memory-growth report). The ring buffer keeps only the most recent
 * `maxEntries` lines; the tail is exactly what the exit diagnostics need.
 */
export class CappedBuffer {
  /** @param {number} maxEntries — maximum number of items to retain */
  constructor(maxEntries) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('CappedBuffer: maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
    /** @type {string[]} */
    this.items = [];
  }

  /**
   * Append an item, evicting the oldest when over capacity.
   * @param {string} item
   */
  push(item) {
    this.items.push(item);
    if (this.items.length > this.maxEntries) {
      // Single bulk splice instead of per-item shift — avoids O(n²) under
      // sustained writes (a noisy daemon could emit many lines per second).
      this.items.splice(0, this.items.length - this.maxEntries);
    }
  }

  /** Snapshot of retained items, oldest → newest. Returns a copy. */
  toArray() {
    return [...this.items];
  }

  /** Number of items currently retained. */
  get length() {
    return this.items.length;
  }
}
