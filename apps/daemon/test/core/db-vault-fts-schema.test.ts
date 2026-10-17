import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/core/db.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vfts-'));
  return openDatabase(dir);
}

describe('vault_files_fts schema', () => {
  test('三表齐备：fts 虚表 + 影子表', () => {
    const db = tmpDb();
    const fts = db.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('vault_files_fts','vault_files_state')",
    ).all() as Array<{ name: string }>;
    assert.equal(fts.length, 2);
  });

  test('trigram 分词：CJK 子串可命中', () => {
    const db = tmpDb();
    db.exec(`INSERT INTO vault_files_fts(content, vault_id, file_path)
             VALUES ('冒用他人信用卡uid', 'v1', 'raw/a.txt')`);
    const hit = db.prepare(
      "SELECT file_path FROM vault_files_fts WHERE vault_files_fts MATCH ? AND vault_id = ?",
    ).get('"他人信用卡"', 'v1') as { file_path: string } | undefined;
    assert.equal(hit?.file_path, 'raw/a.txt');
  });

  test('影子表主键 (vault_id, file_path)：裸 INSERT 撞键、ON CONFLICT 可 upsert', () => {
    const db = tmpDb();
    db.prepare('INSERT INTO vault_files_state(vault_id, file_path, mtime, size) VALUES (?,?,?,?)')
      .run('v1', 'a.md', 1, 10);
    // 裸 INSERT 撞复合主键——PK 生效的直接证据（Task 2 索引器因此必须走 upsert）
    assert.throws(() =>
      db.prepare('INSERT INTO vault_files_state(vault_id, file_path, mtime, size) VALUES (?,?,?,?)')
        .run('v1', 'a.md', 2, 20),
    );
    // 与 Task 2 indexVaultFile 相同的 upsert 写法：更新本 vault 行，不影响别 vault 同名文件
    db.prepare(`INSERT INTO vault_files_state(vault_id, file_path, mtime, size) VALUES (?,?,?,?)
                ON CONFLICT(vault_id, file_path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size`)
      .run('v1', 'a.md', 2, 20);
    db.prepare(`INSERT INTO vault_files_state(vault_id, file_path, mtime, size) VALUES (?,?,?,?)
                ON CONFLICT(vault_id, file_path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size`)
      .run('v2', 'a.md', 3, 30);
    const rows = db.prepare('SELECT mtime, size FROM vault_files_state WHERE vault_id=? AND file_path=?')
      .get('v1', 'a.md') as { mtime: number; size: number };
    assert.deepEqual(rows, { mtime: 2, size: 20 });
    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM vault_files_state').get() as { n: number }).n, 2,
    );
  });
});
