/**
 * Vault filesystem watcher — detects files landing in a vault (Chrome extension
 * clippings, weixin media, external edits) and emits `tree-changed` events so
 * the UI can refresh without relying on window focus.
 *
 * Lifecycle mirrors WeixinService: `start()` watches all known vaults, `stop()`
 * closes every watcher. Individual vault watchers are isolated — one failing
 * does not affect the others.
 *
 * `.git`, dotfiles, and build/dependency directories (node_modules, dist, …)
 * are ignored via the shared `isPrunedDirName` predicate — keeping this in sync
 * with scanTree, and preventing the FD-exhaustion root cause (chokidar held
 * ~10k FDs from a vault's node_modules → posix_spawn EBADF → probeVersion
 * failed → "agent unavailable"). A per-directory child counter backstops any
 * non-pruned oversized directory so an unknown giant folder can't exhaust FDs.
 */
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import chokidar, { type FSWatcher } from 'chokidar';
import { listVaults } from './db.js';
// Import from vault-prune (not knowledge) so this module does NOT transitively
// pull in encoding.ts — tests tune encoding's size caps via env vars at load.
import { isPrunedDirName, MAX_DIR_ENTRIES } from './vault-prune.js';
import { ThrottledWarn } from './throttled-warn.js';

export const VAULT_TREE_CHANGED_EVENT = 'tree-changed';

/**
 * 某个 vault 的监听「就绪 / 失活」时发出（payload = vaultId）。
 *
 * 为什么需要：就绪前（初次扫描中）与监听失败后，落盘变化**不会**产生任何
 * `tree-changed`。把 `tree-changed` 当唯一失效信号的缓存类消费者（图谱缓存）
 * 必须先知道这个信号在不在，否则会把「没有信号」当成「内容没变」。
 */
export const VAULT_WATCH_STATE_CHANGED_EVENT = 'watch-state-changed';

const DEBOUNCE_MS = 300;

export class VaultWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  // 已就绪（初次扫描完成、事件可靠）的 vault。
  private readyVaults = new Set<string>();
  private started = false;
  // Throttles the chokidar 'error' warning per vault — a flapping watched path
  // can fire it continuously (see throttled-warn.ts for the stderr-noise rationale).
  private readonly warn = new ThrottledWarn();

  constructor(
    private readonly db: Database.Database,
    /**
     * Per-directory child cap for the oversize backstop (see watch()). Defaults
     * to the production MAX_DIR_ENTRIES; injectable so tests can exercise the
     * identical overflow branch with a handful of files instead of 5000+ —
     * writing MAX_DIR_ENTRIES real files synchronously is far too slow under
     * full-suite parallel load (the test blew its 30s budget at ~46s wall).
     */
    private readonly maxDirEntries: number = MAX_DIR_ENTRIES,
  ) {
    super();
  }

  /**
   * Watch all vaults currently in the DB. Called once on daemon start.
   * New vaults created later should call {@link watch} explicitly.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const vault of listVaults(this.db)) {
      this.watch(vault.id, vault.path).catch(() => {
        /* individual vault failures are non-fatal */
      });
    }
  }

  /**
   * 该 vault 的监听是否就绪（初次扫描已完成 → 落盘变化会触发 tree-changed）。
   * 就绪前 / 监听失败后为 false：此时**没有**失效信号可用。
   */
  isReady(vaultId: string): boolean {
    return this.readyVaults.has(vaultId);
  }

  /** 就绪态变化时对外广播（只在真正翻转时发）。 */
  private setReady(vaultId: string, ready: boolean): void {
    const was = this.readyVaults.has(vaultId);
    if (ready) this.readyVaults.add(vaultId);
    else this.readyVaults.delete(vaultId);
    if (was !== ready) this.emit(VAULT_WATCH_STATE_CHANGED_EVENT, vaultId);
  }

  /**
   * Start watching a single vault. Idempotent — re-calling with the same id
   * first closes the previous watcher.
   */
  async watch(vaultId: string, vaultPath: string): Promise<void> {
    if (this.watchers.has(vaultId)) {
      await this.unwatch(vaultId);
    }

    // 扫描完成前落盘的变化可能一个事件都没有 → 先声明未就绪（重新 watch
    // 会开出新的空窗，上一个 watcher 的就绪态立即作废）。
    this.setReady(vaultId, false);

    try {
      // `await` works for both chokidar v3 (returns FSWatcher) and v4
      // (returns Promise<FSWatcher>).
      //
      // Resolve to the canonical long path first so the `ignored`/`root`
      // comparisons below are consistent with the paths chokidar reports.
      // Falls back to the original path if resolution fails (e.g. the dir
      // doesn't exist yet).
      let resolvedPath = vaultPath;
      try {
        resolvedPath = realpathSync(vaultPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[vault-watcher] realpath failed for ${vaultId} (${vaultPath}):`, (err as Error).message);
        }
        /* path may not exist yet — watch the original path */
      }
      const root = path.resolve(resolvedPath);

      // Per-directory child counter — best-effort backstop so a non-pruned
      // oversized directory (a folder the user dumped into the vault) can't
      // exhaust file descriptors. chokidar calls `ignored` once per path it
      // considers; once a single parent has been asked about more than
      // this.maxDirEntries children, ignore the rest. The vault root is never
      // pruned (handled by the `resolved === root` check below), so this only
      // bounds nested directories. Walk order is not guaranteed, so this is a
      // hard cap on per-directory work, not a precise threshold.
      const dirChildCounts = new Map<string, number>();

      const watcher = await chokidar.watch(resolvedPath, {
        // Ignore dotfile entries (.git, .claude, .gitignore) and build/dependency
        // directories (node_modules, dist, …) via the shared isPrunedDirName —
        // same predicate scanTree uses, so the watcher and the displayed tree
        // agree on what counts as knowledge. Never ignore the vault root itself,
        // even if its name or an ancestor starts with a dot.
        ignored: (p) => {
          const resolved = path.resolve(p);
          if (resolved === root) return false;
          const base = resolved.split(/[/\\]/).pop() ?? '';
          if (isPrunedDirName(base)) return true;
          // Per-dir backstop: count how many children of this parent chokidar
          // has asked about; once past the cap, ignore the overflow.
          const parent = path.dirname(resolved);
          const next = (dirChildCounts.get(parent) ?? 0) + 1;
          dirChildCounts.set(parent, next);
          return next > this.maxDirEntries;
        },
        ignoreInitial: true,
        persistent: true,
        // On Windows, chokidar's per-directory fs.watch (ReadDirectoryChangesW)
        // triggers a libuv process-abort assertion when the watched path's form
        // doesn't match what the OS reports (src/win/fs-event.c:72,
        // !wcsnicmp) — this fires on the CI runner and would crash any user
        // whose vault path has a >8-char segment (Windows generates 8.3 short
        // names for those). Polling bypasses fs.watch entirely (uses stat
        // polling), so the assertion can never fire. Cost: ~1s landing latency
        // and light CPU — acceptable for "see landed files without refocusing".
        // macOS/Linux keep native fs.watch (kqueue/inotify/FSEvents) — no such
        // assertion, instant notifications.
        ...(process.platform === 'win32'
          ? { usePolling: true, interval: 1000, binaryInterval: 3000 }
          : {}),
      });

      const handleChange = () => this.scheduleEmit(vaultId);

      watcher.on('add', handleChange);
      watcher.on('change', handleChange);
      watcher.on('unlink', handleChange);
      watcher.on('addDir', handleChange);
      watcher.on('unlinkDir', handleChange);
      watcher.on('error', (err) => {
        this.warn.warn(
          `error:${vaultId}`,
          `[vault-watcher] error for ${vaultId} (${vaultPath}): ${(err as Error).message}`,
        );
      });

      this.watchers.set(vaultId, watcher);

      // Wait for the initial scan to complete so callers (and tests) can write
      // files and reliably receive events. Bound by a timeout so a missing
      // path never hangs watch() forever.
      //
      // 超时兜底（2s，大库/慢盘上扫描可能更久）到点后也算「就绪」：chokidar
      // 在扫描期间已经在收事件，只是不知道后续还有没有初始扫描的 add 要发。
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        watcher.once('ready', done);
        setTimeout(done, 2000).unref?.();
      });
      // 只有仍是当前 watcher 才算就绪——同 id 的 watch() 可能已经把它顶掉：
      // 旧 watcher 的 ready 不能替新 watcher 宣布「信号可用」。
      if (this.watchers.get(vaultId) === watcher) this.setReady(vaultId, true);
    } catch (err) {
      this.setReady(vaultId, false);
      console.warn(`[vault-watcher] failed to watch ${vaultId} (${vaultPath}):`, (err as Error).message);
    }
  }

  /** Stop watching a single vault. */
  async unwatch(vaultId: string): Promise<void> {
    this.setReady(vaultId, false);
    const timer = this.timers.get(vaultId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(vaultId);
    }
    const watcher = this.watchers.get(vaultId);
    if (watcher) {
      try {
        await watcher.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(vaultId);
    }
  }

  /** Stop all watchers. Safe to call on shutdown. */
  async stop(): Promise<void> {
    const ids = Array.from(this.watchers.keys());
    await Promise.all(ids.map((id) => this.unwatch(id)));
    this.started = false;
  }

  private scheduleEmit(vaultId: string): void {
    const existing = this.timers.get(vaultId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(vaultId);
      this.emit(VAULT_TREE_CHANGED_EVENT, vaultId);
    }, DEBOUNCE_MS);
    // Don't keep the process alive solely for a debounce timer.
    timer.unref?.();
    this.timers.set(vaultId, timer);
  }
}
