import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault, addExternalRoot } from '../../src/core/db.js';
import { VaultWatcher, VAULT_TREE_CHANGED_EVENT } from '../../src/core/vault-watcher.js';

/**
 * VaultWatcher must cover registered external source roots, not just the vault
 * root — otherwise a file landing in a mounted folder fires no `tree-changed`
 * and the UI tree goes stale. The design rule is "refresh boundary == scan
 * boundary": scanTree walks the external roots, so the watcher must too.
 *
 * Timing rationale mirrors vault-watcher.test.ts: chokidar's native backend
 * (FSEvents/inotify) has subscription latency after `ready`, and the emit is
 * debounced a further 300ms, so we poll for the event with a generous bound
 * instead of sleeping a fixed interval.
 */

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('VaultWatcher covers external roots', () => {
  let dataDir: string;
  let vaultPath: string;
  let ext: string;
  let db: Database.Database;
  let watcher: VaultWatcher;
  let vaultId: string;

  before(async () => {
    // openDatabase() takes a *directory* (it opens <dir>/app.sqlite), so pass a
    // real temp dir — ':memory:' would create a stray directory named that.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-'));
    db = openDatabase(dataDir);
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const vault = createVault(db, 'V', vaultPath);
    vaultId = vault.id;
    addExternalRoot(db, vaultId, 'AgentA', ext);
  });

  after(async () => {
    await watcher?.stop();
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  });

  it('emits tree-changed when a file lands in a registered external root', { timeout: 30000 }, async () => {
    watcher = new VaultWatcher(db);
    await watcher.watch(vaultId, vaultPath);
    // Let the native backend settle before writing. On macOS the FSEvents
    // subscription can lag chokidar's `ready` event, so a write in the very
    // next tick is occasionally missed — see vault-watcher.test.ts.
    await settle(300);

    let timer: ReturnType<typeof setInterval> | undefined;
    const hit = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        clearInterval(timer);
        resolve(false);
      }, 8000);
      watcher.once(VAULT_TREE_CHANGED_EVENT, () => {
        clearTimeout(t);
        clearInterval(timer);
        resolve(true);
      });
      // Keep landing fresh files in the external root until the emit arrives.
      // Under a loaded CI runner the subscription can still lag the settle
      // above; re-triggering makes the assertion test the implementation, not
      // the event-delivery latency of the host.
      timer = setInterval(() => {
        fs.writeFileSync(path.join(ext, `new-${Date.now()}.md`), 'x');
      }, 1000);
    });
    fs.writeFileSync(path.join(ext, 'new.md'), 'x');
    assert.equal(await hit, true, 'external write should trigger tree-changed');
  });

  it('an unregistered/missing external target does not break watch()', { timeout: 20000 }, async () => {
    // A root whose target directory is gone (unplugged drive / deleted folder)
    // must not throw or hang — the watcher just skips it.
    fs.rmSync(ext, { recursive: true, force: true });

    const w = new VaultWatcher(db);
    const settled = await Promise.race([
      w.watch(vaultId, vaultPath).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 10000)),
    ]);
    assert.equal(settled, true, 'watch() must resolve even when an external target is missing');
    await w.stop();

    // Restore for any later assertions / teardown symmetry.
    fs.mkdirSync(ext, { recursive: true });
  });
});
