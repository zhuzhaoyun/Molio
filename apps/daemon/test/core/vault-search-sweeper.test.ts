import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/core/db.js';
import { VaultIndexSweeper } from '../../src/core/vault-search.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-swp-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-swp-db-')));
  db.prepare('INSERT INTO vaults (id, name, path, created_at) VALUES (?,?,?,?)')
    .run(V, '库', vaultDir, Date.now());
});
const hit = (q: string): boolean =>
  !!db.prepare('SELECT 1 FROM vault_files_fts WHERE vault_files_fts MATCH ? AND vault_id=?')
    .get(`"${q}"`, V);

describe('VaultIndexSweeper', () => {
  test('agent/外部直写的新文件经防抖 sweep 后可搜', async () => {
    const sw = new VaultIndexSweeper(db, { debounceMs: 20 });
    fs.writeFileSync(path.join(vaultDir, 'agent-write.md'), '智能体直写的内容标记QWERTY', 'utf-8');
    sw.scheduleVault(V);
    await sleep(80);
    assert.equal(hit('内容标记QWERTY'), true);
    sw.stop();
  });

  test('同 vault 连续触发合并为一次 sweep（不叠加定时器）', async () => {
    const sw = new VaultIndexSweeper(db, { debounceMs: 30 });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(vaultDir, `burst${i}.md`), `连发内容标记${i}ZXCV`, 'utf-8');
      sw.scheduleVault(V);
      await sleep(5);
    }
    await sleep(120);
    assert.equal(hit('连发内容标记'), true);
    sw.stop();
  });

  test('sweepVaultNow 同步生效；未知 vault 不抛', () => {
    const sw = new VaultIndexSweeper(db, { debounceMs: 20 });
    fs.writeFileSync(path.join(vaultDir, 'now.md'), '立即扫内容标记ASDF', 'utf-8');
    sw.sweepVaultNow(V);
    assert.equal(hit('立即扫内容标记ASDF'), true);
    sw.sweepVaultNow('ghost-vault'); // 不抛即可
    sw.stop();
  });

  test('stop 后不再扫', async () => {
    const sw = new VaultIndexSweeper(db, { debounceMs: 20 });
    sw.stop();
    fs.writeFileSync(path.join(vaultDir, 'late.md'), '停止后写入POIUK', 'utf-8');
    sw.scheduleVault(V);
    await sleep(80);
    assert.equal(hit('停止后写入POIUK'), false);
    sw.stop();
  });

  test('scheduleAll 覆盖 vaults 表全部 vault', async () => {
    fs.writeFileSync(path.join(vaultDir, 'all.md'), '全量预索引标记QAZWS', 'utf-8');
    const sw = new VaultIndexSweeper(db, { debounceMs: 20 });
    sw.scheduleAll();
    await sleep(120);
    assert.equal(hit('全量预索引标记QAZWS'), true);
    sw.stop();
  });
});
