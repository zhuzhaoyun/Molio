import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/core/db.js';
import { searchVaultFiles } from '../../src/core/vault-search.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'vault-1';

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsq-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsq-db-')));
});
function write(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('searchVaultFiles', () => {
  test('空查询短路', async () => {
    assert.deepEqual(await searchVaultFiles(db, V, vaultDir, '  '), { results: [], truncated: false });
  });

  test('首搜自动建库：建库前写入的文件可被搜到', async () => {
    write('a.md', '盗刷定义在刑法第一百九十六条');
    const { results } = await searchVaultFiles(db, V, vaultDir, '盗刷定义');
    assert.equal(results.length, 1);
    assert.equal(results[0]!.filePath, 'a.md');
  });

  test('bm25 排序：词频高的靠前；snippet 含关键词附近文本', async () => {
    write('少.md', '提到盗刷认定一次');
    write('多.md', '盗刷认定盗刷认定盗刷认定，专门讲盗刷认定');
    const { results } = await searchVaultFiles(db, V, vaultDir, '盗刷认定');
    assert.equal(results.length, 2);
    assert.equal(results[0]!.filePath, '多.md');
    assert.ok(results[0]!.snippet.includes('盗刷认定'));
    assert.ok(!/\s{2,}|\n/.test(results[0]!.snippet)); // 与旧实现一致：空白折叠
  });

  test('vault 隔离：同名文件互不串', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsq-o-'));
    fs.writeFileSync(path.join(other, 'x.md'), '只有B库有盗刷数据', 'utf-8');
    db.prepare("INSERT INTO vaults (id, name, path, created_at) VALUES ('v2','二',?,?)")
      .run(other, Date.now());
    write('x.md', '只有A库的内容没有关键词');
    await searchVaultFiles(db, V, vaultDir, '初始化建库'); // 触发 V 建库
    const { results } = await searchVaultFiles(db, 'v2', other, '盗刷数据');
    assert.equal(results.length, 1);
    assert.equal(results[0]!.filePath, 'x.md'); // 来自 v2
  });

  test('两字短查询走 LIKE 回退仍有结果', async () => {
    write('a.md', '盗刷案例');
    const { results } = await searchVaultFiles(db, V, vaultDir, '盗刷'); // 2 字符
    assert.equal(results.length, 1);
  });

  test('两字短查询 snippet 含关键词（取自匹配处，非文件开头）', async () => {
    // 关键词落在 400 字之后——若 snippet 取 substr(content,1,400) 会不含关键词，
    // SearchPanel 的 indexOf 高亮随之失效（旗舰场景：2 字中文查询）
    write('mid.md', '甲乙丙丁戊己庚辛壬癸'.repeat(50) + '盗刷' + '结尾内容'.repeat(20));
    const { results } = await searchVaultFiles(db, V, vaultDir, '盗刷');
    assert.equal(results.length, 1);
    assert.ok(results[0]!.snippet.includes('盗刷'), `snippet 应含关键词，实际: ${results[0]!.snippet}`);
  });

  test('命中文件被外部删除 → 剔除并出索引', async () => {
    write('a.md', '盗刷内容甲乙丙');
    await searchVaultFiles(db, V, vaultDir, '盗刷内容');
    fs.unlinkSync(path.join(vaultDir, 'a.md'));
    const { results } = await searchVaultFiles(db, V, vaultDir, '盗刷内容');
    assert.equal(results.length, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) n FROM vault_files_state WHERE vault_id=?').get(V) as { n: number }).n, 0,
    );
  });

  test('命中文件被外部修改且仍命中 → 重索引后 snippet 更新（查询重跑一轮）', async () => {
    write('a.md', '旧词甲乙丙');
    await searchVaultFiles(db, V, vaultDir, '旧词甲乙');
    const st = fs.statSync(path.join(vaultDir, 'a.md'));
    // 编辑后仍含旧词（新增而非替换）——命中级惰性校验的可及场景
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '旧词甲乙丙加新词丁戊己', 'utf-8');
    fs.utimesSync(path.join(vaultDir, 'a.md'), st.atime, new Date(st.mtimeMs + 5000));
    const { results } = await searchVaultFiles(db, V, vaultDir, '旧词甲乙');
    assert.equal(results.length, 1);
    assert.ok(results[0]!.snippet.includes('新词')); // snippet 来自重索引后的新内容
    // 换新词能搜到属于「发现」，归 tree-changed sweep（Task 7），不归惰性校验
  });

  test('limit 截断标记 truncated', async () => {
    for (let i = 0; i < 5; i++) write(`f${i}.md`, `盗刷场景第${i}号`);
    const { results, truncated } = await searchVaultFiles(db, V, vaultDir, '盗刷场景', 3);
    assert.equal(results.length, 3);
    assert.equal(truncated, true);
  });

  test('warm 索引上搜索零目录遍历（架构断言：查询不 walk）', async () => {
    write('a.md', '盗刷内容甲乙丙');
    await searchVaultFiles(db, V, vaultDir, '盗刷内容'); // 建库
    const readdir = mock.method(fs, 'readdirSync', () => { throw new Error('search must not walk'); });
    try {
      const { results } = await searchVaultFiles(db, V, vaultDir, '盗刷内容');
      assert.equal(results.length, 1);
    } finally {
      readdir.mock.restore();
    }
  });
});
