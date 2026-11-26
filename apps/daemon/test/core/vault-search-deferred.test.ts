/**
 * vault-search 的 deferred minors 回归（docs/2026-10-10-retrieval-p0.md §4.8 一期 #2/#3/#5/#7）。
 * 这些不是新功能，是把 review 记录的缺口逐条钉上测试：
 * - #2 空/全不可索引库每次搜索都 re-walk → seededVaults 标记
 * - #3 truncated 在剔除后计算漏报；重查后沿用旧下标校验
 * - #5 removeVaultFile 未归一化反斜杠
 * - #7 sweeper↔server 接线无测试 → wireVaultSweeper 抽成可单测函数
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../../src/core/db.js';
import {
  searchVaultFiles,
  indexVaultFile,
  removeVaultFile,
  VaultIndexSweeper,
  wireVaultSweeper,
} from '../../src/core/vault-search.js';
import { VAULT_TREE_CHANGED_EVENT, VAULT_WATCH_STATE_CHANGED_EVENT } from '../../src/core/vault-watcher.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'vault-1';

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsd-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsd-db-')));
});
function write(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('searchVaultFiles truncated 语义（#3）', () => {
  test('外部删除被剔除后，truncated 仍按原始命中数判定', async () => {
    write('a.md', '阈值词命中'); write('b.md', '阈值词命中'); write('c.md', '阈值词命中');
    await searchVaultFiles(db, V, vaultDir, '阈值词命中', 2); // 建库
    fs.rmSync(path.join(vaultDir, 'c.md')); // 外部删除：limit+1 榜里剔 1 条
    const { results, truncated } = await searchVaultFiles(db, V, vaultDir, '阈值词命中', 2);
    assert.equal(results.length, 2);
    // 剔除前命中 3 条 > limit 2 → true。旧实现在 splice 后拿 rows.length(2) 比较 → 误报 false。
    assert.equal(truncated, true);
  });

  test('重查后新榜从头重新校验：外部修改与删除并存', async () => {
    write('a.md', '复核词第一版');
    write('b.md', '复核词在B');
    await searchVaultFiles(db, V, vaultDir, '复核词', 10); // 建库
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '复核词第二版加长内容', 'utf-8'); // 外部修改
    fs.rmSync(path.join(vaultDir, 'b.md')); // 外部删除
    const { results } = await searchVaultFiles(db, V, vaultDir, '复核词', 10);
    // a 触发整榜重查；重查后的 b（若仍在索引）必须再次被校验剔除——旧实现沿用
    // 旧下标走新数组，新榜未被旧下标覆盖的行逃过校验。
    assert.deepEqual(results.map((r) => r.filePath), ['a.md']);
    assert.ok(results[0]!.snippet.includes('第二版')); // a 已重索引为新内容
  });
});

describe('removeVaultFile 路径归一（#5）', () => {
  test('Windows 反斜杠形态也能命中删除', () => {
    write('sub/deep.md', '反斜杠归一测试');
    indexVaultFile(db, V, vaultDir, 'sub/deep.md');
    removeVaultFile(db, V, 'sub\\deep.md');
    const row = db.prepare(
      "SELECT 1 AS x FROM vault_files_fts WHERE vault_id = ? AND file_path = 'sub/deep.md'",
    ).get(V);
    assert.equal(row, undefined); // 未归一就是静默 no-op，fts/state 留死行
  });
});

describe('空库 seeded 标记（#2）', () => {
  test('空 vault 第二次搜索不再整库 walk', async (t) => {
    let walks = 0;
    const real = fs.readdirSync.bind(fs);
    const counting = ((...a: Parameters<typeof real>) => {
      walks++;
      return real(...a);
    }) as typeof fs.readdirSync;
    t.mock.method(fs, 'readdirSync', counting);

    await searchVaultFiles(db, V, vaultDir, '随便什么词'); // 首搜：建库 walk 一次
    assert.equal(walks, 1);
    await searchVaultFiles(db, V, vaultDir, '随便什么词'); // 空库影子表仍空，标记防重复 walk
    assert.equal(walks, 1);
  });
});

describe('wireVaultSweeper 接线（#7）', () => {
  test('tree-changed 事件 → 防抖 sweep → 新文件可搜', async () => {
    db.prepare("INSERT INTO vaults (id, name, path, created_at) VALUES (?, 'w', ?, ?)")
      .run(V, vaultDir, Date.now());
    write('late.md', '接线词独有内容');
    const watcher = new EventEmitter();
    const sweeper = new VaultIndexSweeper(db, { debounceMs: 10 });
    wireVaultSweeper(watcher, sweeper);

    watcher.emit(VAULT_TREE_CHANGED_EVENT, V);
    await new Promise((r) => setTimeout(r, 80)); // debounce 10ms + 单文件 walk

    const { results } = await searchVaultFiles(db, V, vaultDir, '接线词独有内容', 5);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.filePath, 'late.md');
    sweeper.stop();
  });

  test('监听重臂（watch-state-changed）→ 同样排 sweep（rebase 合入 main 的重臂监听）', () => {
    const watcher = new EventEmitter();
    const scheduled: string[] = [];
    wireVaultSweeper(watcher, { scheduleVault: (id: string) => scheduled.push(id) });

    watcher.emit(VAULT_WATCH_STATE_CHANGED_EVENT, V);
    assert.deepEqual(scheduled, [V]);
  });
});
