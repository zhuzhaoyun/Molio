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
 *
 * 2026-11-06 second FD-exhaustion incident (v0.4.5): chokidar v4/v5 (fsevents
 * removed) holds **one open read fd per watched file** on macOS for the
 * watcher's whole lifetime — a ~11k-file vault alone saturated the NOFILE
 * ceiling (~10k): every spawn failed with EBADF → all agents probed
 * "unavailable", sends failed with "spawn EBADF", fs-opening routes 500'd.
 * Verified isolation: native `fs.watch(root, { recursive: true })` holds zero
 * per-file fds (FSEvents-backed) and delivers the same events, so on darwin we
 * watch natively and move `isPrunedDirName` pruning to the event side
 * (filename path segments). Windows keeps chokidar (usePolling — the libuv
 * assertion workaround documented below); Linux keeps chokidar (inotify,
 * per-directory watch descriptors — the macOS per-file fd behavior does not
 * apply there).
 */
import { EventEmitter } from 'node:events';
import { realpathSync, statSync, watch as fsWatch, type FSWatcher as NodeFsWatcher } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import chokidar, { type FSWatcher as ChokidarFsWatcher } from 'chokidar';
import { listExternalRoots, listVaults } from './db.js';
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

/**
 * Real paths of those `candidates` that currently resolve to a directory.
 * Only existing directories can be watch targets: a registered root whose
 * target is temporarily gone (unplugged drive, deleted folder) is skipped
 * rather than failing the whole vault watch, and a non-directory would make
 * chokidar watch a file as if it were a tree.
 */
function resolvableDirRealpaths(candidates: string[]): string[] {
  const dirs: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (statSync(real).isDirectory()) dirs.push(real);
    } catch {
      /* missing or unreadable — not watchable right now */
    }
  }
  return dirs;
}

export class VaultWatcher extends EventEmitter {
  private watchers = new Map<string, ChokidarFsWatcher | NodeFsWatcher>();
  /**
   * darwin-only: native per-root watchers for the vault's registered external
   * roots. fs.watch takes one path per call, so each root gets its own handle
   * — 1 fd per ROOT, so the per-file fd leak stays fixed. Closed in unwatch().
   */
  private extraWatchers = new Map<string, NodeFsWatcher[]>();
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
      const handleChange = () => this.scheduleEmit(vaultId);

      // Registered external source roots are watched alongside the vault, so a
      // file landing in a mounted folder also refreshes the tree — the design
      // rule is "refresh boundary == scan boundary" (scanTree walks the same
      // roots). Canonicalized like the vault root above: watchers compare the
      // paths they were handed, and the mount link (`<vault>/external/<label>`)
      // may point at a target that is itself a symlink.
      const extraRoots = resolvableDirRealpaths(
        listExternalRoots(this.db, vaultId).map((r) => r.target),
      );

      // ── macOS: native recursive fs.watch (FSEvents) ──
      // chokidar v4/v5 holds one open read fd per watched file for the
      // watcher's whole lifetime on macOS — watching the ~11k-file vault blew
      // past the NOFILE ceiling and every spawn in the daemon failed with
      // EBADF (2026-11-06 incident: all agents "unavailable", sends died with
      // "spawn EBADF"). Native watch holds zero per-file fds; pruning moves to
      // the event side via filename segments (see nativeEventPruned).
      if (process.platform === 'darwin') {
        const watcher = fsWatch(root, { recursive: true }, (_eventType, filename) => {
          // darwin types give string | null (Buffer is possible on other
          // platforms, which keep the chokidar path); null is treated
          // conservatively — an unknown change is better than a missed one.
          const rel = typeof filename === 'string' ? filename : null;
          if (VaultWatcher.nativeEventPruned(rel)) return;
          handleChange();
        });
        watcher.on('error', (err) => {
          this.setReady(vaultId, false);
          this.warn.warn(
            `error:${vaultId}`,
            `[vault-watcher] error for ${vaultId} (${vaultPath}): ${(err as Error).message}`,
          );
        });
        this.watchers.set(vaultId, watcher);
        // External roots get their own native watchers (fs.watch takes one
        // path per call) — 1 fd per root, the per-file leak stays fixed. Same
        // pruning predicate: `filename` is relative to the watched root, which
        // is exactly what nativeEventPruned expects. A failing extra root
        // warns but does NOT kill the vault's readiness: the vault's own
        // signal is still alive, and mount/unmount re-arms the whole watch.
        if (extraRoots.length > 0) {
          const extras: NodeFsWatcher[] = [];
          for (const extra of extraRoots) {
            try {
              const extraWatcher = fsWatch(extra, { recursive: true }, (_eventType, filename) => {
                const rel = typeof filename === 'string' ? filename : null;
                if (VaultWatcher.nativeEventPruned(rel)) return;
                handleChange();
              });
              extraWatcher.on('error', (err) => {
                this.warn.warn(
                  `error:external:${vaultId}`,
                  `[vault-watcher] external-root watch error for ${vaultId} (${extra}): ${(err as Error).message}`,
                );
              });
              extras.push(extraWatcher);
            } catch (err) {
              this.warn.warn(
                `error:external:${vaultId}`,
                `[vault-watcher] failed to watch external root ${extra} for ${vaultId}: ${(err as Error).message}`,
              );
            }
          }
          this.extraWatchers.set(vaultId, extras);
        }
        // FSEvents delivers from subscription time — no initial scan/`ready`
        // step to wait for. The chokidar path waits ≤2s before declaring
        // readiness; same contract here, just immediate.
        this.setReady(vaultId, true);
        return;
      }

      // Per-directory child counter — best-effort backstop so a non-pruned
      // oversized directory (a folder the user dumped into the vault) can't
      // exhaust file descriptors. chokidar calls `ignored` once per path it
      // considers; once a single parent has been asked about more than
      // this.maxDirEntries children, ignore the rest. The vault root and each
      // external root are never pruned (handled by the `resolved === root ||
      // extraRoots.includes(resolved)` check below), so this only bounds
      // nested directories. Walk order is not guaranteed, so this is a hard cap
      // on per-directory work, not a precise threshold.
      const dirChildCounts = new Map<string, number>();

      const watcher = await chokidar.watch([resolvedPath, ...extraRoots], {
        // Ignore dotfile entries (.git, .claude, .gitignore) and build/dependency
        // directories (node_modules, dist, …) via the shared isPrunedDirName —
        // same predicate scanTree uses, so the watcher and the displayed tree
        // agree on what counts as knowledge. Never ignore the vault root, nor an
        // external root itself (same exemption as the vault root — the mounted
        // folder is knowledge no matter what it is named or where it lives),
        // even if the name or an ancestor starts with a dot.
        ignored: (p) => {
          const resolved = path.resolve(p);
          if (resolved === root || extraRoots.includes(resolved)) return false;
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
    const extras = this.extraWatchers.get(vaultId);
    if (extras) {
      for (const extraWatcher of extras) {
        try {
          extraWatcher.close();
        } catch {
          /* ignore */
        }
      }
      this.extraWatchers.delete(vaultId);
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

  /**
   * Event-side pruning for the native (darwin) watcher: drop events whose
   * root-relative filename contains ANY pruned path segment (.git, dotfiles,
   * node_modules, dist, …) — the native recursive watch cannot pre-filter
   * subtrees the way chokidar's `ignored` can, so noise events from build
   * directories are filtered here instead of becoming tree-changed storms.
   *
   * `null` filename is treated conservatively (NOT pruned) — an unknown
   * change is better than a missed one. Events naming the vault root itself
   * carry the root's basename, which never matches a pruned segment.
   */
  private static nativeEventPruned(filename: string | null): boolean {
    if (filename === null) return false;
    return filename.split(/[\\/]/).some((seg) => seg !== '' && isPrunedDirName(seg));
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

  /**
   * Announce a content mutation that chokidar will NOT see, so the whole
   * tree-changed fan-out (SSE clients, tree/graph cache invalidation, FTS
   * sweeper) reacts through the single existing channel.
   *
   * The consumer is the external-root mount/unmount route: it creates/removes
   * the mount link inside the vault and immediately re-arms the watcher — the
   * OLD watcher is closed before the OS delivers the link's add/remove event,
   * and the new one runs with ignoreInitial:true, so without this call no
   * tree-changed ever fires: the FTS sweeper never rebuilds (an already-seeded
   * vault silently misses the entire mounted corpus in search) and other open
   * KB windows keep a stale tree.
   */
  notifyExternalMutation(vaultId: string): void {
    this.scheduleEmit(vaultId);
  }
}
