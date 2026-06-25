/**
 * Vault filesystem watcher — detects files landing in a vault (Chrome extension
 * clippings, weixin media, external edits) and emits `tree-changed` events so
 * the UI can refresh without relying on window focus.
 *
 * Lifecycle mirrors WeixinService: `start()` watches all known vaults, `stop()`
 * closes every watcher. Individual vault watchers are isolated — one failing
 * does not affect the others.
 *
 * `.git` and dotfiles are ignored: they aren't part of the displayed tree
 * (scanTree skips dotfiles), and ignoring `.git` prevents our own ingest
 * commits from self-triggering a refresh loop.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type Database from 'better-sqlite3';
import chokidar, { type FSWatcher } from 'chokidar';
import { listVaults } from './db.js';

export const VAULT_TREE_CHANGED_EVENT = 'tree-changed';

const DEBOUNCE_MS = 300;

export class VaultWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  constructor(private readonly db: Database.Database) {
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
   * Start watching a single vault. Idempotent — re-calling with the same id
   * first closes the previous watcher.
   */
  async watch(vaultId: string, vaultPath: string): Promise<void> {
    if (this.watchers.has(vaultId)) {
      await this.unwatch(vaultId);
    }

    try {
      // `await` works for both chokidar v3 (returns FSWatcher) and v4
      // (returns Promise<FSWatcher>).
      const root = path.resolve(vaultPath);
      const watcher = await chokidar.watch(vaultPath, {
        // Ignore dotfile entries (.git, .claude, .gitignore) — they aren't in
        // the displayed tree (scanTree skips dotfiles) and watching .git would
        // self-trigger on our own ingest commits. Never ignore the vault root
        // itself, even if its name or an ancestor starts with a dot.
        ignored: (p) => {
          const resolved = path.resolve(p);
          if (resolved === root) return false;
          const base = resolved.split(/[/\\]/).pop() ?? '';
          return base.startsWith('.') && base !== '.';
        },
        ignoreInitial: true,
        persistent: true,
      });

      const handleChange = () => this.scheduleEmit(vaultId);

      watcher.on('add', handleChange);
      watcher.on('change', handleChange);
      watcher.on('unlink', handleChange);
      watcher.on('addDir', handleChange);
      watcher.on('unlinkDir', handleChange);
      watcher.on('error', (err) => {
        console.warn(`[vault-watcher] error for ${vaultId} (${vaultPath}):`, (err as Error).message);
      });

      this.watchers.set(vaultId, watcher);

      // Wait for the initial scan to complete so callers (and tests) can write
      // files and reliably receive events. Bound by a timeout so a missing
      // path never hangs watch() forever.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        watcher.once('ready', done);
        setTimeout(done, 2000).unref?.();
      });
    } catch (err) {
      console.warn(`[vault-watcher] failed to watch ${vaultId} (${vaultPath}):`, (err as Error).message);
    }
  }

  /** Stop watching a single vault. */
  async unwatch(vaultId: string): Promise<void> {
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
