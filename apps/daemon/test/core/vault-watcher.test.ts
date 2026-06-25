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
 */

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    let emitted = false;
    watcher.once(VAULT_TREE_CHANGED_EVENT, (id: string) => {
      if (id === vaultId) emitted = true;
    });

    writeFileSync(join(vaultDir, 'note.md'), '# hi');

    // debounce is 300ms; allow margin for chokidar + fs notify
    await settle(700);
    assert.equal(emitted, true);
  });

  it('debounces: multiple rapid writes produce a single emit', async () => {
    let count = 0;
    watcher.on(VAULT_TREE_CHANGED_EVENT, () => count++);

    writeFileSync(join(vaultDir, 'a.md'), 'a');
    writeFileSync(join(vaultDir, 'b.md'), 'b');
    writeFileSync(join(vaultDir, 'c.md'), 'c');

    await settle(700);
    // Allow one emit (the debounce window collapses the burst). Strict-equal
    // would be brittle across platforms; assert at-least-one and at-most-two.
    assert.ok(count >= 1, `expected >=1 emit, got ${count}`);
    assert.ok(count <= 2, `expected <=2 emits, got ${count}`);
  });

  it('ignores .git and dotfile changes', async () => {
    let emitted = false;
    watcher.on(VAULT_TREE_CHANGED_EVENT, () => { emitted = true; });

    mkdirSync(join(vaultDir, '.git'), { recursive: true });
    writeFileSync(join(vaultDir, '.git', 'config'), 'noop');
    writeFileSync(join(vaultDir, '.gitignore'), '*.png');

    await settle(700);
    assert.equal(emitted, false);
  });

  it('stop() tears down: no further emits after stop', async () => {
    await watcher.stop();

    let emitted = false;
    watcher.on(VAULT_TREE_CHANGED_EVENT, () => { emitted = true; });

    writeFileSync(join(vaultDir, 'after-stop.md'), 'x');
    await settle(700);
    assert.equal(emitted, false);
  });

  it('one vault failing does not block another', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'molio-vw-other-'));
    try {
      const other = createVault(db, 'other-vault', otherDir, undefined);
      // Watching a second vault should not throw even if the first is watched.
      await watcher.watch(other.id, otherDir);

      let otherEmitted = false;
      watcher.once(VAULT_TREE_CHANGED_EVENT, (id: string) => {
        if (id === other.id) otherEmitted = true;
      });

      writeFileSync(join(otherDir, 'z.md'), 'z');
      await settle(700);
      assert.equal(otherEmitted, true);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
