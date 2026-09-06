import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { buildGraph, buildLocalGraph, graphRoutes } from '../../src/routes/graph.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';

/**
 * 局部图谱单测（buildLocalGraph + GET /api/graph/:vaultId/local）。
 *
 * 设计：docs/2026-09-04-local-graph-scope-design.md §3 / §七
 * - file scope：圆心 + 1 跳邻居（含死链目标）+ 诱导边；圆心不存在/孤立 → 空图
 * - dir scope：目录前缀下全部 .md + 内部边 + 邻接死链；跨目录真实边界不含
 * 每个用例独立临时 vault，互不污染。
 */

const dirs: string[] = [];

function makeVault(...files: Array<[rel: string, content: string]>): string {
  const d = mkdtempSync(join(tmpdir(), 'molio-graph-local-test-'));
  dirs.push(d);
  for (const [rel, content] of files) {
    const abs = join(d, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, { encoding: 'utf-8' });
  }
  return d;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('buildLocalGraph — file scope（1 跳邻域）', () => {
  it('圆心 + 入边/出边邻居 + 诱导边，不含 2 跳', () => {
    // x ← a → b → d（d 是 2 跳）；a → c
    const g = buildLocalGraph(
      makeVault(
        ['a.md', '# A\n\n[[x]] [[b]] [[c]]\n'],
        ['b.md', '# B\n\n[[d]]\n'],
        ['c.md', '# C\n'],
        ['d.md', '# D\n'],
        ['x.md', '# X\n'],
      ),
      { type: 'file', path: 'a.md' },
    );
    assert.deepStrictEqual(
      g.nodes.map((n) => n.key).sort(),
      ['a.md', 'b.md', 'c.md', 'x.md'],
      '2 跳 d.md 不入选',
    );
    assert.strictEqual(g.edges.length, 3, 'x-a / a-b / a-c');
    assert.deepStrictEqual(g.focusNodes, ['a.md']);
  });

  it('邻居之间的诱导边包含在内', () => {
    // a → b, a → c, b → c
    const g = buildLocalGraph(
      makeVault(
        ['a.md', '# A\n\n[[b]] [[c]]\n'],
        ['b.md', '# B\n\n[[c]]\n'],
        ['c.md', '# C\n'],
      ),
      { type: 'file', path: 'a.md' },
    );
    assert.strictEqual(g.nodes.length, 3);
    assert.strictEqual(g.edges.length, 3, 'b-c 边两端都在节点集内 → 保留');
  });

  it('死链目标作为 1 跳 deadLink 邻居并入', () => {
    const g = buildLocalGraph(makeVault(['a.md', '# A\n\n[[ghost]]\n']), {
      type: 'file',
      path: 'a.md',
    });
    const ghost = g.nodes.find((n) => n.deadLink);
    assert.ok(ghost, '死链节点存在');
    assert.strictEqual(ghost!.label, 'ghost');
    assert.strictEqual(g.edges.length, 1);
    assert.strictEqual(g.deadLinks.length, 1);
    assert.deepStrictEqual(g.focusNodes, ['a.md']);
  });

  it('孤立文档（无任何链接）→ 空图', () => {
    const g = buildLocalGraph(makeVault(['lone.md', '# Lone\n']), { type: 'file', path: 'lone.md' });
    assert.strictEqual(g.nodes.length, 0);
    assert.strictEqual(g.edges.length, 0);
    assert.deepStrictEqual(g.focusNodes, []);
  });

  it('不存在的 path / 被剔除名（index.md）/ 非 .md 目标 → 空图', () => {
    const vault = makeVault(['a.md', '# A\n'], ['index.md', '# idx\n'], ['img.png', 'not-md']);
    for (const p of ['nope.md', 'index.md', 'img.png']) {
      const g = buildLocalGraph(vault, { type: 'file', path: p });
      assert.strictEqual(g.nodes.length, 0, p);
      assert.deepStrictEqual(g.focusNodes, []);
    }
  });
});

describe('buildLocalGraph — dir scope（文件夹子图）', () => {
  it('目录递归下全部 .md + 内部诱导边，跨目录真实边界不含', () => {
    const g = buildLocalGraph(
      makeVault(
        ['wiki/x/p.md', '# P\n\n[[q]] [[sub/r]] [[outside]]\n'],
        ['wiki/x/q.md', '# Q\n'],
        ['wiki/x/sub/r.md', '# R\n'],
        ['outside.md', '# O\n'],
      ),
      { type: 'dir', path: 'wiki/x' },
    );
    assert.deepStrictEqual(
      g.nodes.map((n) => n.key).sort(),
      ['wiki/x/p.md', 'wiki/x/q.md', 'wiki/x/sub/r.md'],
      '递归覆盖 sub/；真实文件 outside.md 是边界，不含',
    );
    assert.strictEqual(g.edges.length, 2, 'p-q / p-r；p-outside 剔除');
    assert.strictEqual(g.focusNodes.length, 3, 'dir scope focusNodes=全部节点');
  });

  it('目录内节点链到目录外死链 → 死链节点并入', () => {
    const g = buildLocalGraph(
      makeVault(['wiki/x/p.md', '# P\n\n[[ghost]]\n'], ['wiki/x/q.md', '# Q\n']),
      { type: 'dir', path: 'wiki/x' },
    );
    const ghost = g.nodes.find((n) => n.deadLink);
    assert.ok(ghost, '目录外死链目标并入');
    assert.strictEqual(g.edges.length, 1, 'p-ghost');
  });

  it('空目录 / 无 .md 目录 / 不存在目录 → 空图', () => {
    const vault = makeVault(['wiki/x/img.png', 'x'], ['other.md', '# O\n']);
    for (const p of ['wiki/x', 'wiki/none']) {
      const g = buildLocalGraph(vault, { type: 'dir', path: p });
      assert.strictEqual(g.nodes.length, 0, p);
      assert.deepStrictEqual(g.focusNodes, []);
    }
  });
});

describe('buildGraph 全量图不受 focusNodes 污染', () => {
  it('全量图输出不含 focusNodes 字段', () => {
    const g = buildGraph(makeVault(['a.md', '# A\n\n[[b]]\n'], ['b.md', '# B\n']));
    assert.ok(!('focusNodes' in g));
  });
});

describe('GET /api/graph/:vaultId/local', () => {
  let app: Hono;
  let vaultId: string;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-graph-local-route-'));
    dirs.push(tempDir);
    const vaultDir = join(tempDir, 'vault');
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, 'a.md'), '# A\n\n[[b]]\n', 'utf-8');
    writeFileSync(join(vaultDir, 'b.md'), '# B\n', 'utf-8');
    mkdirSync(join(vaultDir, 'wiki', '易经'), { recursive: true });
    writeFileSync(join(vaultDir, 'wiki', '易经', 'p.md'), '# P\n\n[[q]]\n', 'utf-8');
    writeFileSync(join(vaultDir, 'wiki', '易经', 'q.md'), '# Q\n', 'utf-8');
    writeFileSync(join(vaultDir, 'outside.md'), '# O\n', 'utf-8');
    const db = openDatabase(tempDir);
    const vault = createVault(db, 'graph-local-vault', vaultDir);
    vaultId = vault.id;
    const root = new Hono();
    root.route('/api/graph', graphRoutes(db));
    app = root;
  });

  after(() => {
    closeDatabase();
  });

  it('file scope：圆心 + 1 跳邻居 + focusNodes', async () => {
    const res = await app.request(`/api/graph/${vaultId}/local?scope=file&path=a.md`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { nodes: { key: string }[]; edges: unknown[]; focusNodes: string[] };
    assert.deepEqual(body.focusNodes, ['a.md']);
    assert.deepEqual(
      body.nodes.map((n) => n.key).sort(),
      ['a.md', 'b.md'],
    );
    assert.equal(body.edges.length, 1);
  });

  it('dir scope：中文目录（URL 编码）返回目录子图', async () => {
    const res = await app.request(
      `/api/graph/${vaultId}/local?scope=dir&path=${encodeURIComponent('wiki/易经')}`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { nodes: { key: string }[]; focusNodes: string[] };
    assert.deepEqual(body.nodes.map((n) => n.key).sort(), ['wiki/易经/p.md', 'wiki/易经/q.md']);
    assert.equal(body.focusNodes.length, 2);
  });

  it('scope 非法 → 400', async () => {
    const res = await app.request(`/api/graph/${vaultId}/local?scope=both&path=a.md`);
    assert.equal(res.status, 400);
  });

  it('缺 path → 400', async () => {
    const res = await app.request(`/api/graph/${vaultId}/local?scope=file`);
    assert.equal(res.status, 400);
  });

  it('depth > 1 → 400（本轮仅支持 1）', async () => {
    const res = await app.request(`/api/graph/${vaultId}/local?scope=file&path=a.md&depth=2`);
    assert.equal(res.status, 400);
  });

  it('vault 不存在 → 404', async () => {
    const res = await app.request('/api/graph/nope/local?scope=file&path=a.md');
    assert.equal(res.status, 404);
  });
});
