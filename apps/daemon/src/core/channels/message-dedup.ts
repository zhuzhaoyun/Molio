/**
 * Cross-channel inbound message dedup.
 *
 * Both weixin (via polling) and feishu (via WS reconnect) can redeliver the
 * same message_id within a short window — the daemon must drop the second
 * delivery or the user gets duplicate replies. The state (a Map of id →
 * first-seen timestamp) and the TTL sweep are identical across channels;
 * only the cap policy differs (weixin: unbounded; feishu: 10k cap to bound
 * memory on a quiet-but-long-lived process).
 */
export interface MessageDedupOptions {
  /** TTL on a message_id entry — entries older than this are evicted on the next check. */
  ttlMs: number;
  /**
   * Optional hard cap on the map size. When set, the oldest entry (by insertion
   * order) is evicted before inserting a new one once the cap is reached.
   * When unset, the map is bounded only by TTL eviction.
   */
  maxEntries?: number;
}

export class MessageDedup {
  private readonly seen = new Map<string, number>();

  constructor(private readonly opts: MessageDedupOptions) {}

  /**
   * Record `id` and report whether it's a duplicate.
   * Returns `true` if `id` was already seen within the TTL window (a duplicate
   * the caller should drop); `false` if it's new (the caller should process).
   * Side-effect: sweeps expired entries on each call so a quiet channel doesn't
   * leak memory.
   */
  check(id: string): boolean {
    const now = Date.now();
    // Sweep expired entries. Map iteration order = insertion order, so the loop
    // can stop at the first non-expired entry (the rest are necessarily newer).
    for (const [seenId, ts] of this.seen) {
      if (now - ts > this.opts.ttlMs) {
        this.seen.delete(seenId);
      } else {
        break;
      }
    }
    if (this.seen.has(id)) return true;
    // Hard cap (optional): evict the oldest before inserting so the map never
    // grows unbounded on a quiet-but-long-lived process that never sweeps.
    if (this.opts.maxEntries !== undefined && this.seen.size >= this.opts.maxEntries) {
      const firstKey = this.seen.keys().next().value;
      if (firstKey !== undefined) this.seen.delete(firstKey);
    }
    this.seen.set(id, now);
    return false;
  }
}
