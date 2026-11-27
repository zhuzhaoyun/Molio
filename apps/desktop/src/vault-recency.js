/**
 * Recently-opened vault LRU backing the macOS dock menu's 「最近使用的知识库」
 * submenu.
 *
 * main.js records which vaults the user actually opens (via `?vault=` in SPA
 * navigation) so the dock menu can surface the most recent ones first, across
 * app restarts. This module is deliberately Electron-free: `read`/`write` are
 * injected, so ordering, eviction, and persistence are unit-testable without
 * spinning up a window.
 */

/**
 * @param {object} opts
 * @param {() => unknown} [opts.read] — returns the persisted array (or anything;
 *   non-arrays / throws are treated as an empty history).
 * @param {(entries: Array<{id: string, lastUsed: number}>) => void} [opts.write] —
 *   best-effort persist; throws are swallowed.
 * @param {() => number} [opts.now] — epoch-ms clock (injectable for tests).
 * @param {number} [opts.limit] — max vaults retained (bounds the file size).
 */
export function createVaultRecency({ read, write, now = Date.now, limit = 10 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('vault-recency: limit must be a positive integer');
  }
  /** @type {Map<string, number>} vaultId → lastUsed epoch-ms */
  const entries = new Map();

  if (read) {
    try {
      const saved = read();
      if (Array.isArray(saved)) {
        for (const entry of saved) {
          if (
            entry && typeof entry.id === 'string' &&
            typeof entry.lastUsed === 'number' && Number.isFinite(entry.lastUsed)
          ) {
            entries.set(entry.id, entry.lastUsed);
          }
        }
      }
    } catch {
      // Corrupt/unreadable file — start empty; the next touch rewrites it.
    }
  }

  function persist() {
    if (!write) return;
    try {
      write([...entries.entries()].map(([id, lastUsed]) => ({ id, lastUsed })));
    } catch {
      // Persistence is best-effort — never break navigation over a disk hiccup.
    }
  }

  /** Record that a vault was just opened; it becomes the most recent. */
  function touch(id) {
    if (typeof id !== 'string' || id.length === 0) return;
    entries.set(id, now());
    if (entries.size > limit) {
      const excess = [...entries.entries()]
        .sort((a, b) => a[1] - b[1]) // oldest first
        .slice(0, entries.size - limit);
      for (const [oldId] of excess) entries.delete(oldId);
    }
    persist();
  }

  /** Vault ids ordered most-recently-used first (newest touch wins). */
  function orderedIds() {
    return [...entries.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  return { touch, orderedIds };
}
