import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, deleteVault } from '../../src/core/db.js';
import { indexVaultFile, removeVaultFile, removeVaultDir } from '../../src/core/vault-search.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'vault-1';

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsi-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsi-db-')));
});

function write(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

function ftsHit(rel: string, q: string): boolean {
  return !!db.prepare(
    'SELECT 1 FROM vault_files_fts WHERE vault_files_fts MATCH ? AND vault_id = ? AND file_path = ?',
  ).get(`"${q.replaceAll('"', '""')}"`, V, rel);
}

describe('indexVaultFile', () => {
  test('索引后可按内容子串命中', () => {
    write('notes/刑法.md', '盗刷是指冒用他人信用卡。');
    indexVaultFile(db, V, vaultDir, 'notes/刑法.md');
    assert.equal(ftsHit('notes/刑法.md', '冒用他人'), true);
  });

  test('mtime+size 未变 → 不重读内容（影子表跳过）', () => {
    write('a.md', '第一版内容标记XYZ');
    indexVaultFile(db, V, vaultDir, 'a.md');
    // 直接改 fts 行内容模拟「已索引态」，再索引同文件——若重读会被改回
    db.exec(`UPDATE vault_files_fts SET content='TOMBSTONE' WHERE file_path='a.md'`);
    indexVaultFile(db, V, vaultDir, 'a.md');
    const c = db.prepare("SELECT content FROM vault_files_fts WHERE file_path='a.md'").get() as { content: string };
    assert.equal(c.content, 'TOMBSTONE');
  });

  test('mtime 变了 → 重索引新内容', () => {
    write('a.md', '旧内容甲乙丙');
    indexVaultFile(db, V, vaultDir, 'a.md');
    const st = fs.statSync(path.join(vaultDir, 'a.md'));
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '新内容丁戊己庚', 'utf-8');
    fs.utimesSync(path.join(vaultDir, 'a.md'), st.atime, new Date(st.mtimeMs + 5000));
    indexVaultFile(db, V, vaultDir, 'a.md');
    assert.equal(ftsHit('a.md', '丁戊己'), true);
    assert.equal(ftsHit('a.md', '甲乙丙'), false);
  });

  test('文件已删除 → 索引与影子表一并移除', () => {
    write('a.md', '内容某某某');
    indexVaultFile(db, V, vaultDir, 'a.md');
    fs.unlinkSync(path.join(vaultDir, 'a.md'));
    indexVaultFile(db, V, vaultDir, 'a.md');
    assert.equal(ftsHit('a.md', '某某某'), false);
    const state = db.prepare('SELECT 1 FROM vault_files_state WHERE vault_id=? AND file_path=?').get(V, 'a.md');
    assert.equal(state, undefined);
  });

  test('非文本扩展名不索引；超过 2MB 不索引', () => {
    write('img.png', 'binaryish');
    indexVaultFile(db, V, vaultDir, 'img.png');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM vault_files_state WHERE vault_id=?').get(V) as { n: number }).n, 0);
    write('big.md', 'x'.repeat(2 * 1024 * 1024 + 1));
    indexVaultFile(db, V, vaultDir, 'big.md');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM vault_files_state WHERE vault_id=?').get(V) as { n: number }).n, 0);
  });

  test('vault 外路径拒绝（防穿越）', () => {
    assert.throws(() => indexVaultFile(db, V, vaultDir, '../outside.md'));
  });
});

describe('removeVaultFile / removeVaultDir', () => {
  test('removeVaultFile 清 fts + 影子表', () => {
    write('a.md', '内容某某某');
    indexVaultFile(db, V, vaultDir, 'a.md');
    removeVaultFile(db, V, 'a.md');
    assert.equal(ftsHit('a.md', '某某某'), false);
  });

  test('removeVaultDir 按前缀清整个目录', () => {
    write('raw/feishu/1.md', '文件一内容');
    write('raw/feishu/sub/2.md', '文件二内容');
    write('raw/keep.md', '保留内容');
    for (const p of ['raw/feishu/1.md', 'raw/feishu/sub/2.md', 'raw/keep.md']) indexVaultFile(db, V, vaultDir, p);
    removeVaultDir(db, V, 'raw/feishu');
    assert.equal(ftsHit('raw/feishu/1.md', '文件一'), false);
    assert.equal(ftsHit('raw/feishu/sub/2.md', '文件二'), false);
    assert.equal(ftsHit('raw/keep.md', '保留内容'), true);
  });

  test('removeVaultDir 不误删同 LIKE 模式的兄弟目录（_ 是通配符）', () => {
    write('a_b/x.md', '下划线目录内容');
    write('axb/y.md', '兄弟目录内容');
    indexVaultFile(db, V, vaultDir, 'a_b/x.md');
    indexVaultFile(db, V, vaultDir, 'axb/y.md');
    removeVaultDir(db, V, 'a_b');
    assert.equal(ftsHit('a_b/x.md', '下划线目录内容'), false);
    assert.equal(ftsHit('axb/y.md', '兄弟目录内容'), true); // 不得被当作 LIKE 通配误删
  });

  test('deleteVault 清空该库的索引（不残留原文）', () => {
    db.prepare('INSERT INTO vaults (id, name, path, created_at) VALUES (?,?,?,?)')
      .run(V, '库', vaultDir, Date.now());
    write('a.md', '盗刷残留内容甲乙丙');
    indexVaultFile(db, V, vaultDir, 'a.md');
    assert.equal(ftsHit('a.md', '残留内容甲'), true);

    deleteVault(db, V);
    const fts = (db.prepare('SELECT COUNT(*) n FROM vault_files_fts WHERE vault_id=?').get(V) as { n: number }).n;
    const state = (db.prepare('SELECT COUNT(*) n FROM vault_files_state WHERE vault_id=?').get(V) as { n: number }).n;
    assert.equal(fts, 0);   // 删库后原文不得滞留索引
    assert.equal(state, 0);
  });
});
