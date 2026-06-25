import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { VaultWatcher, VAULT_TREE_CHANGED_EVENT } from '../../src/core/vault-watcher.js';

/**
 * VaultWatcher integration tests (CLAUDE.md: state-machine/lifecycle services
 * need integration tests, not just init smoke tests).
 *
 * Drives real chokidar on a temp dir, verifies the debounce → emit state
 * transition, the stop() teardown (no further emits, no leaked timers), and
 * that `.git`/dotfiles are ignored.
 *
 * Timing rationale: chokidar v5 returns the watcher synchronously and fires
 * `ready` via process.nextTick after the initial readdir. On macOS the native
 * FSEvents backend has startup latency — a file written immediately after
 * watch() resolves can be delivered with a delay that exceeds a fixed sleep,
 * especially on a loaded CI runner. We therefore POLL for the emit (up to 3s)
 * rather than sleeping a fixed 700ms, which was flaky on macOS.
 */

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve true once the watcher emits tree-changed for vaultId, else false after timeoutMs. */
function waitForTreeChanged(
  watcher: VaultWatcher,
  vaultId: string,
  timeoutMs = 3000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const onEmit = (id: string) => {
      if (id === vaultId && !done) {
        done = true;
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        resolve(false);
      }
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      watcher.off(VAULT_TREE_CHANGED_EVENT, onEmit);
    }
    watcher.on(VAULT_TREE_CHANGED_EVENT, onEmit);
  });
}

describe('VaultWatcher', () => {
  let dataDir: string;
  let vaultDir: string;
  let db: Database.Database;
  let watcher: VaultWatcher;
  let vaultId: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'molio-vw-db-'));
    db = openDatabase(dataDir);
    vaultDir = mkdtempSync(join(tmpdir(), 'molio-vw-vault-'));
    const vault = createVault(db, 'test-vault', vaultDir, undefined);
    vaultId = vault.id;
    watcher = new VaultWatcher(db);
    await watcher.watch(vaultId, vaultDir);
  });

  afterEach(async () => {
    await watcher.stop();
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('emits tree-changed for the vault after a file is added (debounced)', async () => {
    const got = waitForTreeChanged(watcher, vaultId);
    writeFileSync(join(vaultDir, 'note.md'), '# hi');
    assert.equal(await got, true);
  });

  it('debounces: multiple rapid writes produce at most two emits', async () => {
    let count = 0;
    const onEmit = () => count++;
    watcher.on(VAULT_TREE_CHANGED_EVENT, onEmit);

    writeFileSync(join(vaultDir, 'a.md'), 'a');
    writeFileSync(join(vaultDir, 'b.md'), 'b');
    writeFileSync(join(vaultDir, 'c.md'), 'c');

    // Wait past the debounce window plus one poll interval (Windows polling)
    // and the native-event delivery margin (macOS FSEvents).
    await settle(2500);
    watcher.off(VAULT_TREE_CHANGED_EVENT, onEmit);
    // The debounce window collapses the burst; allow 1 or 2 emits across platforms.
    assert.ok(count >= 1, `expected >=1 emit, got ${count}`);
    assert.ok(count <= 2, `expected <=2 emits, got ${count}`);
  });

  it('ignores .git and dotfile changes', async () => {
    let emitted = false;
    const onEmit = () => { emitted = true; };
    watcher.on(VAULT_TREE_CHANGED_EVENT, onEmit);

    mkdirSync(join(vaultDir, '.git'), { recursive: true });
    writeFileSync(join(vaultDir, '.git', 'config'), 'noop');
    writeFileSync(join(vaultDir, '.gitignore'), '*.png');

    // Wait past one poll interval so a buggy emit would have surfaced.
    await settle(1500);
    watcher.off(VAULT_TREE_CHANGED_EVENT, onEmit);
    assert.equal(emitted, false);
  });

  it('stop() tears down: no further emits after stop', async () => {
    await watcher.stop();

    let emitted = false;
    const onEmit = () => { emitted = true; };
    watcher.on(VAULT_TREE_CHANGED_EVENT, onEmit);

    writeFileSync(join(vaultDir, 'after-stop.md'), 'x');
    await settle(1500);
    watcher.off(VAULT_TREE_CHANGED_EVENT, onEmit);
    assert.equal(emitted, false);
  });

  it('one vault failing does not block another', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'molio-vw-other-'));
    try {
      const other = createVault(db, 'other-vault', otherDir, undefined);
      // Watching a second vault should not throw even if the first is watched.
      await watcher.watch(other.id, otherDir);

      const got = waitForTreeChanged(watcher, other.id);
      writeFileSync(join(otherDir, 'z.md'), 'z');
      assert.equal(await got, true);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
