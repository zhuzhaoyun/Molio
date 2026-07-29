/**
 * Vault tree-pruning predicate + hard caps.
 *
 * Shared by the vault tree scanner (scanTree, countFiles, findFileByStem,
 * searchFiles, walkWiki) and the filesystem watcher (VaultWatcher) so the two
 * never diverge on "what counts as knowledge".
 *
 * Kept in a dependency-free module on purpose: importing it (e.g. from
 * VaultWatcher) must NOT transitively load encoding.ts, because some tests
 * tune encoding's size caps (MOLIO_MAX_VIEW_SIZE / MOLIO_HARD_CAP) via env
 * vars at their own module-load time, and a transitive load here would cache
 * the defaults before those vars are set.
 */
import { ThrottledWarn } from './throttled-warn.js';

/**
 * Directory names that are never part of the knowledge tree — they hold build
 * artifacts / dependencies / VCS data, often tens of thousands of files.
 * Walking or watching them exhausts file descriptors and blocks the event
 * loop (the root cause of the "agent unavailable" bug: chokidar held ~10k FDs
 * from a vault's node_modules, starving posix_spawn → probeVersion failed).
 *
 * Dotfile entries (.git, .molio, .claude, …) are also pruned; listing .git/.svn
 * /.hg explicitly here is just for clarity.
 */
export const PRUNE_DIR_NAMES = new Set([
  'node_modules', 'bower_components', 'jspm_packages',
  '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo',
  '.parcel-cache', 'coverage', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'venv', '.venv', 'env',
  'target', '.gradle',
]);

/**
 * True if a directory entry should be pruned wholesale (not readdir, not stat,
 * not watched). Add a new artifact directory here once and both the scanner
 * and the watcher pick it up.
 */
export function isPrunedDirName(name: string): boolean {
  return (name.startsWith('.') && name !== '.') || PRUNE_DIR_NAMES.has(name);
}

/**
 * Hard cap on immediate entries in a single directory. A non-pruned directory
 * above this is almost certainly not knowledge (a dumped dataset, a decompressed
 * archive) — prune the whole subtree instead of stat-ing thousands of files.
 * One readdir is a single syscall, so this never blocks the event loop.
 */
export const MAX_DIR_ENTRIES = 1000;

/**
 * Hard cap on total files processed in one scan. Guards against deep trees
 * where every directory is under MAX_DIR_ENTRIES but the total is huge. Real
 * knowledge bases stay well under this; artifacts are already pruned by name.
 */
export const MAX_TOTAL = 50000;

// ─── throttled "oversized directory" warning ───
//
// scanTree / countFiles walk the whole vault and prune any directory above
// MAX_DIR_ENTRIES. The UI re-scans the vault on every `tree-changed` event
// (debounced at only 300ms), and `GET /vaults` / `GET /active-vault` re-count on
// mount and vault switch — so during an active agent run (wiki-build writes many
// files) the same oversized directory is re-pruned many times a second. Each
// prune used to emit a fresh console.warn; Node writes console.warn to stderr,
// and cloud log collectors (Logtail/SLS) classify every stderr line as an ERROR,
// turning a stable, expected condition into thousands of false anomalies.
//
// The fix: warn at most once per (source, dir) per interval. Suppressed repeats
// are folded into the next emitted warning so the volume stays visible without
// flooding stderr. The warning still resurfaces periodically, so it is not
// permanently hidden. The throttle machinery lives in throttled-warn.ts and is
// shared with the other rate-limited daemon warnings.

/** Re-warn for the same oversized directory at most this often. */
export const OVERSIZED_DIR_WARN_INTERVAL_MS = 5 * 60 * 1000;

const oversizedDirWarn = new ThrottledWarn({ intervalMs: OVERSIZED_DIR_WARN_INTERVAL_MS });

/**
 * Emit a "pruned oversized directory" warning at most once per
 * {@link OVERSIZED_DIR_WARN_INTERVAL_MS} for a given (source, dir) pair.
 * Repeats inside the window are counted and reported in the next emitted
 * warning. `now` is injectable for deterministic tests.
 */
export function warnOversizedDir(
  source: string,
  dir: string,
  entries: number,
  limit: number,
  now: number = Date.now(),
): void {
  oversizedDirWarn.warn(
    `${source}:${dir}`,
    `[knowledge] ${source} pruned oversized directory (${entries} entries, limit ${limit}): ${dir}`,
    now,
  );
}

/** Reset throttle state — test hook so cases start from a clean slate. */
export function resetOversizedDirWarnState(): void {
  oversizedDirWarn.reset();
}
