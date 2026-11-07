import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import {
  VaultWatcher,
  VAULT_TREE_CHANGED_EVENT,
  VAULT_WATCH_STATE_CHANGED_EVENT,
} from '../../src/core/vault-watcher.js';

// Injected per-dir cap so the oversize-backstop test exercises the IDENTICAL
// overflow branch (`next > maxDirEntries`) with ~350 files instead of
// MAX_DIR_ENTRIES (5000) + 300. Writing 5300 files synchronously took ~46s
// under full-suite parallel load and blew the global 30s --test-timeout; the
// backstop logic is the same regardless of the cap's value, so a small cap
// tests the same code path in a fraction of the time. Must exceed the max files
// any OTHER test writes to one dir (≤3) so those never trip the overflow.
const TEST_MAX_DIR_ENTRIES = 50;

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
  timeoutMs = 5000,
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
    watcher = new VaultWatcher(db, TEST_MAX_DIR_ENTRIES);
    await watcher.watch(vaultId, vaultDir);
    // Let the native backend settle before the test writes. On macOS the
    // FSEvents subscription can lag chokidar's `ready` event, so a write in
    // the very next tick is occasionally missed (flake on the first test).
    await settle(300);
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
    // darwin native watch: the segment filter drops .git/.gitignore events, but
    // FSEvents additionally coalesces root-level child changes into an event
    // naming the vault root itself — unattributable, so a debounced emit may
    // still fire. There the contract degrades to "bounded emits" (debounce);
    // the chokidar path (win/linux) keeps the strict zero-emit contract.
    const emitted: number[] = [];
    const onEmit = () => { emitted.push(Date.now()); };
    watcher.on(VAULT_TREE_CHANGED_EVENT, onEmit);

    mkdirSync(join(vaultDir, '.git'), { recursive: true });
    writeFileSync(join(vaultDir, '.git', 'config'), 'noop');
    writeFileSync(join(vaultDir, '.gitignore'), '*.png');

    // Wait past one poll interval so a buggy emit would have surfaced.
    await settle(1500);
    watcher.off(VAULT_TREE_CHANGED_EVENT, onEmit);
    if (process.platform === 'darwin') {
      assert.ok(emitted.length <= 2, `expected <=2 debounced emits, got ${emitted.length}`);
    } else {
      assert.equal(emitted.length, 0);
    }
  });

  it('ignores node_modules changes (the FD-exhaustion root cause)', async () => {
    // See the .git test above for the darwin coalescing caveat: the event-side
    // filter drops node_modules events; only root-coalesced FSEvents events
    // may still emit (bounded by the debounce). The fd explosion this test
    // commemorates is covered separately by the fd-leak regression test.
    const emitted: number[] = [];
    const onEmit = () => { emitted.push(Date.now()); };
    watcher.on(VAULT_TREE_CHANGED_EVENT, onEmit);

    mkdirSync(join(vaultDir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(vaultDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1');
    writeFileSync(join(vaultDir, 'node_modules', 'added-later.js'), 'x');

    await settle(1500);
    watcher.off(VAULT_TREE_CHANGED_EVENT, onEmit);
    if (process.platform === 'darwin') {
      assert.ok(emitted.length <= 2, `expected <=2 debounced emits, got ${emitted.length}`);
    } else {
      assert.equal(emitted.length, 0, 'node_modules writes must not trigger tree-changed');
    }
  });

  it('per-dir backstop: a non-blacklisted oversized dir does not hang the watcher', async () => {
    if (process.platform === 'darwin') {
      // darwin watches natively (no per-path ignored bookkeeping, no fd
      // pressure) — the backstop is a chokidar-path safety and is only
      // exercised on win/linux CI.
      return;
    }
    // Drop a directory with far more entries than the injected cap that is NOT
    // in the prune list. The watcher's per-dir child counter must ignore the
    // overflow rather than trying to track every path.
    mkdirSync(join(vaultDir, 'dump'), { recursive: true });
    // A few hundred past the (injected) cap — enough to exercise the overflow
    // path on every platform without making the test itself slow. See
    // TEST_MAX_DIR_ENTRIES: the production cap (5000) made this write 5300 files
    // and time out under load; 50 keeps the identical branch at ~350 files.
    const overBy = 300;
    for (let i = 0; i < TEST_MAX_DIR_ENTRIES + overBy; i++) {
      writeFileSync(join(vaultDir, 'dump', `f${i}.md`), 'x');
    }

    // Re-watch with the oversized dir present. watch() must still resolve
    // promptly — the backstop prunes the overflow instead of tracking every file.
    const ready = watcher.watch(vaultId, vaultDir);
    const settled = await Promise.race([
      ready.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    assert.equal(settled, true, 'watch() should resolve within 5s even with an oversized dir');

    // A normal knowledge file outside the dump still emits tree-changed.
    const got = waitForTreeChanged(watcher, vaultId, 5000);
    writeFileSync(join(vaultDir, 'outside.md'), 'x');
    assert.equal(await got, true);
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

  it('readiness: 未就绪 → 就绪，重新 watch / unwatch 都翻转并广播', async () => {
    // 从没 watch 过的 vault 永远是「未就绪」——这正是图谱缓存拒绝缓存它的依据：
    // 监听没建立，落盘变化不会有 tree-changed，缓存只会变成陈旧数据。
    const neverDir = mkdtempSync(join(tmpdir(), 'molio-vw-never-'));
    const never = createVault(db, 'never-watched', neverDir, undefined);
    assert.equal(watcher.isReady(never.id), false, 'unwatched vault must not report ready');

    // beforeEach 里已经 watch 过本 vault → 就绪
    assert.equal(watcher.isReady(vaultId), true);

    const states: boolean[] = [];
    const onState = (id: string) => {
      if (id === vaultId) states.push(watcher.isReady(id));
    };
    watcher.on(VAULT_WATCH_STATE_CHANGED_EVENT, onState);

    // 重新 watch：旧 watcher 先失活（新扫描空窗），完成后再就绪
    await watcher.watch(vaultId, vaultDir);
    assert.equal(watcher.isReady(vaultId), true);
    assert.deepEqual(states, [false, true], `expected down-then-up, got ${JSON.stringify(states)}`);

    states.length = 0;
    await watcher.unwatch(vaultId);
    assert.equal(watcher.isReady(vaultId), false);
    assert.deepEqual(states, [false], 'unwatch must broadcast the loss of the signal');

    // 恢复监听，让 afterEach 的 stop() 走正常路径
    await watcher.watch(vaultId, vaultDir);
    assert.equal(watcher.isReady(vaultId), true);

    watcher.off(VAULT_WATCH_STATE_CHANGED_EVENT, onState);
    rmSync(neverDir, { recursive: true, force: true });
  });

  it('one vault failing does not block another', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'molio-vw-other-'));
    try {
      const other = createVault(db, 'other-vault', otherDir, undefined);
      // Watching a second vault should not throw even if the first is watched.
      await watcher.watch(other.id, otherDir);
      // Let the second watcher's polling record its initial (empty) state
      // before writing, so the next poll detects the new file reliably. On a
      // loaded CI runner the second watcher's first poll can lag.
      await settle(300);

      const got = waitForTreeChanged(watcher, other.id, 5000);
      writeFileSync(join(otherDir, 'z.md'), 'z');
      assert.equal(await got, true);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('darwin: watching many files must not hold one fd per file (2026-11-06 fd-leak regression)', async () => {
    // chokidar v4/v5 on macOS keeps one open read fd per watched file for the
    // watcher's whole lifetime. A ~11k-file vault saturated the process fd
    // limit: every spawn failed with EBADF — all agents probed "unavailable"
    // and sends died with "spawn EBADF" (2026-11-06 v0.4.5 incident). The
    // fix watches natively on darwin (fs.watch recursive / FSEvents), which
    // holds zero per-file fds. This test pins that property.
    //
    // Scale note: chokidar's leaked-fd fraction is timing/scale dependent —
    // measured 16/80 at 80 files, ~55-100% at thousands (flat 3000 → +1664,
    // 2087-file vault → +2087). A small tree under-detects, so this test uses
    // 1500 files and a conservative threshold (300) that the native watcher
    // passes with a wide margin and chokidar trips deterministically.
    if (process.platform !== 'darwin') return; // chokidar path; no /dev/fd there
    // IMPORTANT: use a fresh watcher with the PRODUCTION per-dir cap. The
    // shared `watcher` fixture injects TEST_MAX_DIR_ENTRIES=50, whose backstop
    // prunes >50-entry dirs — masking the leak this test guards against (the
    // production watcher only prunes at 5000, so a 1500-file dir stays watched
    // and chokidar holds ~1 fd per file).
    const prodWatcher = new VaultWatcher(db);
    const bigDir = mkdtempSync(join(tmpdir(), 'molio-vw-big-'));
    try {
      const FILE_COUNT = 1500;
      for (let i = 0; i < FILE_COUNT; i++) {
        writeFileSync(join(bigDir, `f${i}.md`), 'x');
      }
      const countOpenFds = () => readdirSync('/dev/fd').length;
      const before = countOpenFds();
      await prodWatcher.watch(vaultId, bigDir);
      // The leak, if present, happens at watch setup (initial scan holds the
      // fds). Re-watch of an existing id also exercises the unwatch-then-watch
      // path used by vault switching.
      await settle(3000);
      const delta = countOpenFds() - before;
      assert.ok(
        delta < 300,
        `watching ${FILE_COUNT} files must not hold ~${FILE_COUNT} fds (delta ${delta})`,
      );
      await prodWatcher.unwatch(vaultId);
    } finally {
      await prodWatcher.stop();
      rmSync(bigDir, { recursive: true, force: true });
    }
  });
});
