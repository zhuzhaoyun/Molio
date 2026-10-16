/**
 * 回归：vault_files_fts 的删除必须走 rowid 配对，不得按 UNINDEXED 列全表扫描。
 *
 * 报障（2026-10-16，Windows，PR #339 分支实测）：daemon 启动后 CPU 100% 卡死
 * 6 分钟+，/api/health 超时、切换知识库后文件树打不开。CDP 抓栈定位在
 * removeVaultFile 的 `DELETE FROM vault_files_fts WHERE vault_id=? AND file_path=?`
 * ——vault_id/file_path 是 FTS5 UNINDEXED 列，这条 DELETE 是**全表扫描**（逐行
 * 读出 trigram 大文本比对），几千文件的库单条就是秒级 CPU；walk 里每个非文本
 * 文件（图片/PDF，isIndexableExt 不过）都会走到 removeVaultFile，海量 no-op
 * 扫描连片独占事件循环——分片让位（每 50 文件 setImmediate 一拍）救不了单条
 * 语句的开销。
 *
 * 修复：rowid 配对约定（src/core/vault-search.ts 头注释）——fts 行 rowid 恒等于
 * vault_files_state 行 rowid；删文件先按 state 主键查 rowid（O(log n)，没有
 * state 行直接早退），再按 rowid 删 fts 行（O(log n)）。本文件锁死的不变量：
 *   1. no-op 删除风暴必须廉价（旧实现 200 次 × 2 条全表扫描是秒级）
 *   2. 配对在索引 / 重索引 / 删除 / 目录删除后恒成立
 *   3. 无配对的存量旧库迁移时清空重建，且幂等（不重复清）
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import { reindexVault, removeVaultFile, removeVaultDir, indexVaultFile } from '../../src/core/vault-search.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'vault-1';

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsrd-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsrd-db-')));
});

function write(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** fts↔state 逐行 JOIN 后校验 rowid 相等——JOIN 本身是全表扫，仅测试小数据用。 */
function pairedRows(): Array<{ rid: number; srid: number; p: string }> {
  return db.prepare(`
    SELECT f.rowid AS rid, s.rowid AS srid, f.file_path AS p
    FROM vault_files_fts f
    JOIN vault_files_state s ON s.vault_id = f.vault_id AND s.file_path = f.file_path
    WHERE f.vault_id = ?
  `).all(V) as Array<{ rid: number; srid: number; p: string }>;
}

describe('no-op 删除风暴（本次卡死的直接根因）', () => {
  test('海量不存在的路径 removeVaultFile 必须廉价，不扫 fts 全表', async () => {
    // 造出有分量的库：40 文件 × 50KB，一次全表扫描有可测成本（旧实现 200 次
    // × 2 条扫描在此规模下秒级；新实现按 state 主键早退，毫秒）
    const big = `内容标记${'x'.repeat(50)}`;
    for (let i = 0; i < 40; i++) write(`f${i}.md`, big.repeat(1000));
    await reindexVault(db, V, vaultDir, { yieldEvery: 0 });
    assert.equal(pairedRows().length, 40);

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) removeVaultFile(db, V, `不存在的路径-${i}.md`);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(
      ms < 500,
      `200 次 no-op 删除耗时 ${ms.toFixed(0)}ms——按 UNINDEXED 列 DELETE 是 fts 全表扫描（walk 里的图片/PDF 都会触发，正是 2026-10-16 Windows 卡死的根因）`,
    );
    // no-op 不得误伤真实索引
    assert.equal(pairedRows().length, 40);
  });

  test('walk 遇到非文本文件（图片等）触发的是 no-op 早退，不产生扫描', async () => {
    for (let i = 0; i < 10; i++) write(`f${i}.md`, `第${i}号内容`);
    for (let i = 0; i < 10; i++) write(`img${i}.png`, 'binaryish-not-text');
    const t0 = process.hrtime.bigint();
    await reindexVault(db, V, vaultDir, { yieldEvery: 0 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(pairedRows().length, 10, 'png 不得进索引');
    assert.ok(ms < 2000, `带 10 个非文本文件的整库索引耗时 ${ms.toFixed(0)}ms，异常`);
  });
});

describe('rowid 配对不变量', () => {
  test('索引后每条 fts 行 rowid == 对应 state 行 rowid', async () => {
    for (let i = 0; i < 12; i++) write(`f${i}.md`, `第${i}号内容`);
    await reindexVault(db, V, vaultDir, { yieldEvery: 0 });
    const rows = pairedRows();
    assert.equal(rows.length, 12);
    for (const r of rows) {
      assert.equal(r.rid, r.srid, `配对破坏：fts rowid ${r.rid} ≠ state rowid ${r.srid}（${r.p}）`);
    }
  });

  test('重索引改动文件：旧 fts 行按 rowid 删除、state rowid 复用不变', async () => {
    write('a.md', '旧内容甲乙丙');
    write('b.md', '内容丁戊己');
    await reindexVault(db, V, vaultDir, { yieldEvery: 0 });
    const ridBefore = (db.prepare(
      'SELECT rowid AS rid FROM vault_files_state WHERE vault_id=? AND file_path=?',
    ).get(V, 'a.md') as { rid: number }).rid;

    const st = fs.statSync(path.join(vaultDir, 'a.md'));
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '新内容庚辛壬', 'utf-8');
    fs.utimesSync(path.join(vaultDir, 'a.md'), st.atime, new Date(st.mtimeMs + 5000));
    await reindexVault(db, V, vaultDir, { yieldEvery: 0 });

    // 旧内容出榜、新内容命中，且每文件恰一行（旧行没残留）
    const hit = (q: string): number =>
      (db.prepare(
        'SELECT COUNT(*) n FROM vault_files_fts WHERE vault_files_fts MATCH ? AND vault_id=?',
      ).get(`"${q}"`, V) as { n: number }).n;
    assert.equal(hit('甲乙丙'), 0, '改写后旧内容不得再命中（旧 fts 行必须删掉）');
    assert.equal(hit('庚辛壬'), 1);
    assert.equal(pairedRows().length, 2, 'a/b 各一行，不多不少');
    const ridAfter = (db.prepare(
      'SELECT rowid AS rid FROM vault_files_state WHERE vault_id=? AND file_path=?',
    ).get(V, 'a.md') as { rid: number }).rid;
    assert.equal(ridAfter, ridBefore, 'state rowid 必须复用（upsert 保 rowid），配对才不被破坏');
  });

  test('removeVaultFile / removeVaultDir 后余下行配对仍成立', async () => {
    for (const p of ['raw/1.md', 'raw/sub/2.md', 'keep.md']) write(p, `内容${p}`);
    await reindexVault(db, V, vaultDir, { yieldEvery: 0 });
    removeVaultFile(db, V, 'keep.md');
    removeVaultDir(db, V, 'raw');
    const rows = pairedRows();
    assert.equal(rows.length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM vault_files_state WHERE vault_id=?').get(V) as { n: number }).n, 0);
    // 重新索引后配对从零建立
    for (const p of ['raw/1.md', 'keep.md']) indexVaultFile(db, V, vaultDir, p);
    const again = pairedRows();
    assert.equal(again.length, 2);
    for (const r of again) assert.equal(r.rid, r.srid);
  });
});

describe('旧库迁移（vault_fts_rowid_paired）', () => {
  test('无配对的存量索引被清空重建，迁移幂等不重复清', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsrd-mig-'));
    const db1 = openDatabase(dir);
    // 模拟旧版本写入：fts 行 rowid 与 state 行无配对（裸 INSERT 自增 rowid）
    db1.exec(`
      INSERT INTO vault_files_fts(content, vault_id, file_path) VALUES ('旧存量内容', 'v1', 'legacy.md');
      INSERT INTO vault_files_state(vault_id, file_path, mtime, size) VALUES ('v1', 'legacy.md', 1, 1);
    `);
    db1.prepare('DELETE FROM kv WHERE key = ?').run('vault_fts_rowid_paired');
    closeDatabase();

    // 重开：迁移清空两表并置 flag
    const db2 = openDatabase(dir);
    const fts = (db2.prepare('SELECT COUNT(*) n FROM vault_files_fts').get() as { n: number }).n;
    const state = (db2.prepare('SELECT COUNT(*) n FROM vault_files_state').get() as { n: number }).n;
    assert.equal(fts, 0, '旧的不配对 fts 行必须清空（否则按 rowid 删会漏删）');
    assert.equal(state, 0, 'state 必须同步清空（否则 sweep 影子判变会跳过重建）');
    assert.equal(
      (db2.prepare('SELECT value FROM kv WHERE key = ?').get('vault_fts_rowid_paired') as { value: string }).value,
      '1',
    );

    // 写入新索引后重开：幂等，不再清
    fs.writeFileSync(path.join(dir, 'new.md'), '迁移后新内容庚癸');
    indexVaultFile(db2, 'v1', dir, 'new.md');
    closeDatabase();
    const db3 = openDatabase(dir);
    assert.equal(
      (db3.prepare('SELECT COUNT(*) n FROM vault_files_state').get() as { n: number }).n,
      1,
      '第二次打开不得再次清空（迁移必须幂等）',
    );
    const rows = db3.prepare(`
      SELECT f.rowid AS rid, s.rowid AS srid
      FROM vault_files_fts f JOIN vault_files_state s
        ON s.vault_id = f.vault_id AND s.file_path = f.file_path
    `).all() as Array<{ rid: number; srid: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.rid, rows[0]!.srid);
  });
});
