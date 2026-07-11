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
