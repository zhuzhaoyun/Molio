/**
 * 层 2 向量层单测（core/vault-vec.ts）。嵌入器全部用确定性 stub（关键词→向量
 * 字典），不拉真模型——真模型的行为在 Task 0 探针与验收 gate（E2 同义改写集）
 * 里验，单测只钉工程语义：分块、新鲜度、余弦排序、降级。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/core/db.js';
import { chunkText, meanPool, vecBuildVault, vecSearch, type Embedder } from '../../src/core/vault-vec.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'vault-1';

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vv-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vv-db-')));
});
function write(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}
function insertVaultRow(): void {
  db.prepare("INSERT INTO vaults (id, name, path, created_at) VALUES (?, 'v', ?, ?)")
    .run(V, vaultDir, Date.now());
}

/** 关键词→向量字典的确定性 stub：文本含某词就叠加该词向量，归一后返回。 */
function stubEmbedder(words: Record<string, number[]>): Embedder & { embedCalls: number } {
  let calls = 0;
  const dims = 4;
  return {
    modelId: 'stub',
    get embedCalls() { return calls; },
    async embed(texts: string[]) {
      calls += texts.length;
      return texts.map((text) => {
        const v = new Float32Array(dims);
        for (const [word, vec] of Object.entries(words)) {
          if (text.includes(word)) {
            for (let i = 0; i < dims; i++) v[i]! += vec[i] ?? 0;
          }
        }
        let norm = 0;
        for (let i = 0; i < dims; i++) norm += v[i]! * v[i]!;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < dims; i++) v[i]! /= norm;
        return v;
      });
    },
    async dispose() { /* stub 无资源 */ },
  };
}

describe('chunkText', () => {
  test('超长段落硬切：每块 ≤400 字符', () => {
    const chunks = chunkText('盗'.repeat(1000));
    assert.equal(chunks.length, 3);
    for (const c of chunks) assert.ok(c.length <= 400);
  });

  test('短段落打包进同一块；空内容返回空', () => {
    const packed = chunkText(['第一段。', '第二段。', '第三段。'].join('\n'));
    assert.equal(packed.length, 1);
    assert.deepEqual(chunkText('  \n  '), []);
  });

  test('maxChunks 封顶：索引成本有上界', () => {
    const long = Array.from({ length: 20 }, (_, i) => `第${i}段。${'字'.repeat(400)}`).join('\n');
    assert.equal(chunkText(long).length, 8);
  });
});

describe('meanPool', () => {
  test('均值 + L2 归一；空输入与零向量返回 undefined', () => {
    const a = new Float32Array([3, 0, 0, 0]);
    const b = new Float32Array([1, 0, 0, 0]);
    const out = meanPool([a, b])!;
    assert.ok(Math.abs(out[0]! - 1) < 1e-6); // 均值 [2,0,0,0] 归一后 [1,0,0,0]
    assert.equal(meanPool([]), undefined);
    assert.equal(meanPool([new Float32Array(4)]), undefined);
  });
});

describe('vecBuildVault 新鲜度', () => {
  test('首建嵌入；未变文件重跑零嵌入；修改与删除各走一步', async () => {
    insertVaultRow();
    write('a.md', '盗刷案例笔记');
    write('sub/b.md', '冒用他人信用卡');
    const embedder = stubEmbedder({ 盗刷: [1, 0, 0, 0], 冒用: [0, 1, 0, 0] });

    const first = await vecBuildVault(db, V, vaultDir, embedder, { yieldEvery: 0 });
    assert.equal(first.indexed, 2);
    const callsAfterFirst = embedder.embedCalls;
    assert.ok(callsAfterFirst > 0);

    // 未变：三要素一致 → 零读零嵌
    const second = await vecBuildVault(db, V, vaultDir, embedder, { yieldEvery: 0 });
    assert.equal(second.indexed, 0);
    assert.equal(embedder.embedCalls, callsAfterFirst);

    // 修改：mtime/size 变 → 该文件重嵌
    write('a.md', '盗刷案例笔记（修订版更长）');
    const third = await vecBuildVault(db, V, vaultDir, embedder, { yieldEvery: 0 });
    assert.equal(third.indexed, 1);
    assert.ok(embedder.embedCalls > callsAfterFirst);

    // 删除：收尾清除向量行
    fs.rmSync(path.join(vaultDir, 'sub/b.md'));
    const fourth = await vecBuildVault(db, V, vaultDir, embedder, { yieldEvery: 0 });
    assert.equal(fourth.removed, 1);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM vault_files_vec WHERE vault_id = ?').get(V) as { n: number };
    assert.equal(rows.n, 1);
  });

  test('换模型（model 列不一致）→ 该文件重算', async () => {
    insertVaultRow();
    write('a.md', '内容无所谓');
    const v1 = stubEmbedder({ 内容: [1, 0, 0, 0] });
    await vecBuildVault(db, V, vaultDir, v1, { yieldEvery: 0 });
    const v2 = { ...stubEmbedder({ 内容: [0, 0, 1, 0] }), modelId: 'stub-v2' };
    const res = await vecBuildVault(db, V, vaultDir, v2, { yieldEvery: 0 });
    assert.equal(res.indexed, 1); // 旧模型行不算新鲜
    const row = db.prepare('SELECT model FROM vault_files_vec WHERE vault_id = ?').get(V) as { model: string };
    assert.equal(row.model, 'stub-v2');
  });
});

describe('vecSearch', () => {
  test('余弦排序：语义近者在前；无语义文件不产生向量行', async () => {
    insertVaultRow();
    write('a.md', '盗刷怎么定性');
    write('b.md', '香蕉苹果都行'); // 含「盗刷」? 不含 → 语义词不同
    write('c.md', '第一段无关键词'); // 无任何字典词 → 零向量 → 不产生向量行
    const embedder = stubEmbedder({ 盗刷: [1, 0, 0, 0], 苹果: [0.6, 0.8, 0, 0] });
    await vecBuildVault(db, V, vaultDir, embedder, { yieldEvery: 0 });

    const { available, results } = await vecSearch(db, V, vaultDir, '盗刷', embedder, 10);
    assert.equal(available, true);
    assert.equal(results[0]!.filePath, 'a.md'); // 同词向量点积最高
    const rows = db.prepare('SELECT COUNT(*) AS n FROM vault_files_vec WHERE vault_id = ?').get(V) as { n: number };
    assert.equal(rows.n, 2); // c.md 零向量不落行
  });

  test('跨 vault 隔离：同名文件互不串', async () => {
    insertVaultRow();
    write('x.md', '盗刷在这里');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vv-o-'));
    fs.writeFileSync(path.join(other, 'x.md'), '只有别的库', 'utf-8');
    db.prepare("INSERT INTO vaults (id, name, path, created_at) VALUES ('v2','二',?,?)")
      .run(other, Date.now());
    const embedder = stubEmbedder({ 盗刷: [1, 0, 0, 0] });
    await vecBuildVault(db, V, vaultDir, embedder, { yieldEvery: 0 });

    const { results } = await vecSearch(db, 'v2', other, '盗刷', embedder, 10);
    assert.deepEqual(results, []); // v2 自己的 x.md 无向量（零词零行），不借 V 的
  });

  test('首搜自动建库：建库前写入的文件可被搜到', async () => {
    insertVaultRow();
    write('late.md', '盗刷笔记尚未建库');
    const embedder = stubEmbedder({ 盗刷: [1, 0, 0, 0] });
    const { results } = await vecSearch(db, V, vaultDir, '盗刷', embedder, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.filePath, 'late.md');
  });

  test('降级：failed 嵌入器返回 available:false 且不抛错', async () => {
    insertVaultRow();
    write('a.md', '盗刷');
    const embedder = stubEmbedder({ 盗刷: [1, 0, 0, 0] });
    (embedder as Embedder & { failed?: boolean }).failed = true;
    const { available, results } = await vecSearch(db, V, vaultDir, '盗刷', embedder, 10);
    assert.equal(available, false);
    assert.deepEqual(results, []);
  });

  test('降级：建库抛错 → available:false，搜索接口不炸', async () => {
    insertVaultRow();
    write('a.md', '盗刷');
    const boom: Embedder = {
      modelId: 'boom',
      async embed() { throw new Error('onnx exploded'); },
      async dispose() {},
    };
    const { available, results } = await vecSearch(db, V, vaultDir, '盗刷', boom, 10);
    assert.equal(available, false);
    assert.deepEqual(results, []);
  });

  test('降级：并发首搜共享的在途构建失败 → 等待方同样 available:false 不外抛', async () => {
    insertVaultRow();
    write('a.md', '盗刷');
    let rejectEmbed: (err: Error) => void = () => {};
    let signalStarted!: () => void;
    const embedStarted = new Promise<void>((r) => { signalStarted = r; });
    const hangBoom: Embedder = {
      modelId: 'hang-boom',
      embed() {
        // 挂起不放行：让首个搜索停在构建中段，制造「在途构建」窗口。
        // 以 embed 真正进入为同步信号（setImmediate 跳数不保证 walk 已到 embed）。
        signalStarted();
        return new Promise<Float32Array[]>((_, reject) => { rejectEmbed = reject; });
      },
      async dispose() {},
    };
    const first = vecSearch(db, V, vaultDir, '盗刷', hangBoom, 10); // 触发建库
    await embedStarted; // 此时构建已登记 in-flight 且停在 embed
    const second = vecSearch(db, V, vaultDir, '盗刷', hangBoom, 10); // 并入同一在途构建
    rejectEmbed(new Error('onnx exploded'));
    const a = await first;
    const b = await second;
    assert.equal(a.available, false);
    assert.equal(b.available, false); // 修复点：等待方此前会随在途构建一起外抛
    assert.deepEqual(b.results, []);
  });
});
