import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/core/db.js';
import { reindexVault, rebuildVaultFtsAll } from '../../src/core/vault-search.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'vault-1';

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsr-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsr-db-')));
});

function write(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}
const stateRows = (): number =>
  (db.prepare('SELECT COUNT(*) n FROM vault_files_state WHERE vault_id=?').get(V) as { n: number }).n;
const hit = (q: string, vid: string = V): number =>
  (db.prepare('SELECT COUNT(*) n FROM vault_files_fts WHERE vault_files_fts MATCH ? AND vault_id=?')
    .get(`"${q}"`, vid) as { n: number }).n;

describe('reindexVault', () => {
  test('全量索引用户目录与 wiki，剪枝目录跳过', () => {
    write('raw/课程笔记.md', '盗刷案例一');
    write('wiki/hot.md', '导航页盗刷条目');
    write('.molio/cache.md', '缓存不应被索引');
    write('node_modules/pkg/a.md', '依赖不应被索引');
    const { indexed } = reindexVault(db, V, vaultDir);
    assert.equal(indexed, 2);
    // trigram 下限：MATCH 查询必须 ≥3 字符（<3 走 LIKE 回退，见 searchVaultFiles）
    assert.equal(hit('盗刷案例'), 1);
    assert.equal(hit('盗刷条目'), 1);
  });

  test('增量：第二次跑未变文件不重读；新增/删除各就各位', () => {
    write('a.md', '内容第一甲乙丙');
    reindexVault(db, V, vaultDir);
    // 篡改 fts 行做「重读探测器」：未变文件不该被改回
    db.exec(`UPDATE vault_files_fts SET content='TOMBSTONE' WHERE file_path='a.md'`);
    write('b.md', '新增文件丁戊己');
    fs.unlinkSync(path.join(vaultDir, 'a.md'));
    const r2 = reindexVault(db, V, vaultDir);
    assert.equal(r2.indexed, 1);   // 只有 b.md
    assert.equal(r2.removed, 1);   // a.md
    assert.equal(stateRows(), 1);
    assert.equal(hit('丁戊己'), 1);
    const c = db.prepare("SELECT content FROM vault_files_fts WHERE file_path='b.md'").get() as { content: string };
    assert.notEqual(c.content, 'TOMBSTONE'); // b.md 是新文件，真读了
  });

  test('MAX_TOTAL 截断不越界', () => {
    for (let i = 0; i < 30; i++) write(`d${i}/f.md`, `内容第${i}批甲乙丙`);
    const r = reindexVault(db, V, vaultDir, { maxTotal: 10 });
    assert.ok(r.indexed <= 10);
  });
});

describe('rebuildVaultFtsAll', () => {
  test('清空重建：多 vault 隔离 + 删文件后索引归零', () => {
    db.prepare("INSERT INTO vaults (id, name, path, created_at) VALUES (?,'一',?,?)")
      .run(V, vaultDir, Date.now());
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsr-2-'));
    db.prepare("INSERT INTO vaults (id, name, path, created_at) VALUES ('v-other','二',?,?)")
      .run(other, Date.now());
    write('a.md', '盗刷资料甲乙丙');
    fs.writeFileSync(path.join(other, 'b.md'), '另一个库的内容', 'utf-8');
    assert.equal(rebuildVaultFtsAll(db).vaults, 2);
    fs.unlinkSync(path.join(vaultDir, 'a.md'));
    rebuildVaultFtsAll(db);
    assert.equal(hit('盗刷资料'), 0);
    assert.equal(hit('另一个库', 'v-other'), 1);
  });
});
