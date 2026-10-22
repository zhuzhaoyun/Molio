import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { buildGraph, isGraphExcludedFile } from '../../src/routes/graph.js';

/**
 * Unit tests for the graph wikilink parser (buildGraph).
 *
 * 关键行为：死链（[[名字]] 指向不存在页面）目标也作为节点并入图，
 * 与引用页建立连线（Obsidian 行为），并用 deadLink 标记区分。
 * 每个用例独立临时 vault，互不污染。
 */

const dirs: string[] = [];

function makeVault(...files: Array<[rel: string, content: string]>): string {
  const d = mkdtempSync(join(tmpdir(), 'molio-graph-test-'));
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

describe('buildGraph dead-link handling', () => {
  it('parses resolved links into nodes + edges', () => {
    const g = buildGraph(makeVault(['a.md', '# A\n\n[[b]]\n'], ['b.md', '# B\n']));

    const a = g.nodes.find((n) => n.key === 'a.md');
    const b = g.nodes.find((n) => n.key === 'b.md');
    assert.ok(a, 'a.md node exists');
    assert.ok(b, 'b.md node exists');
    assert.strictEqual(a.linkCount, 1);
    assert.strictEqual(b.linkCount, 1);
    assert.strictEqual(g.edges.length, 1);
    assert.strictEqual(g.deadLinks.length, 0);
  });

  it('emits dead-link target as a connected deadLink node', () => {
    const g = buildGraph(makeVault(['c.md', '# C\n\n[[ghost]]\n']));

    const ghost = g.nodes.find((n) => n.deadLink);
    assert.ok(ghost, 'dead-link node exists');
    assert.strictEqual(ghost.label, 'ghost');
    assert.strictEqual(ghost.path, '');
    assert.strictEqual(ghost.linkCount, 1, 'dead node counted one reference');

    const edge = g.edges.find(
      (e) => (e.source === ghost.key && e.target === 'c.md') || (e.target === ghost.key && e.source === 'c.md'),
    );
    assert.ok(edge, 'edge connects source to dead node');

    const c = g.nodes.find((n) => n.key === 'c.md');
    assert.ok(c, 'c.md node exists');
    assert.strictEqual(c!.linkCount, 1, '引用页 linkCount 计入死链');

    assert.deepStrictEqual(g.deadLinks, [{ sourceFile: 'c.md', targetName: 'ghost' }]);
  });

  it('dedupes dead nodes by case-insensitive name and aggregates references', () => {
    const g = buildGraph(makeVault(['d1.md', '# D1\n\n[[Foo]]\n'], ['d2.md', '# D2\n\n[[foo]]\n']));

    const deadNodes = g.nodes.filter((n) => n.deadLink);
    assert.strictEqual(deadNodes.length, 1, '[[Foo]] 与 [[foo]] 合并为一个节点');
    assert.strictEqual(deadNodes[0]!.linkCount, 2, '两个引用页都连到同一死链节点');
    assert.strictEqual(deadNodes[0]!.label, 'Foo', '首次出现的大小写作为展示名');
    assert.strictEqual(g.deadLinks.length, 1);
    // 两条边都连到同一死链 key（无向）
    const deadKey = deadNodes[0]!.key;
    const edgesToDead = g.edges.filter((e) => e.source === deadKey || e.target === deadKey);
    assert.strictEqual(edgesToDead.length, 2);
  });

  it('treats link containing a subdirectory as one dead node', () => {
    const g = buildGraph(makeVault(['e.md', '# E\n\n[[parent/leaf]]\n']));

    const dead = g.nodes.find((n) => n.deadLink && n.label === 'parent/leaf');
    assert.ok(dead, '带路径的死链名作为节点');
    assert.strictEqual(dead.path, '', '死链节点无实际文件路径');
  });
});

describe('buildGraph index/log exclusion', () => {
  it('excludes index.md / INDEX.md / log.md at any depth', () => {
    const g = buildGraph(
      makeVault(
        ['a.md', '# A\n\n[[b]]\n'],
        ['b.md', '# B\n'],
        ['index.md', '# root index\n'],
        ['LOG.md', '# root log\n'],
        ['wiki/INDEX.md', '# wiki index\n'],
        ['wiki/log.md', '# wiki log\n'],
        ['wiki/deep/Index.md', '# deep index\n'],
      ),
    );

    const keys = g.nodes.map((n) => n.key).sort();
    assert.deepStrictEqual(keys, ['a.md', 'b.md'], 'index/log 文件不出现在节点中');
    assert.strictEqual(g.edges.length, 1);
  });

  it('links to excluded names are dropped, not dead links', () => {
    const g = buildGraph(
      makeVault(['a.md', '# A\n\n[[INDEX]] [[log]] [[wiki/INDEX]] [[Index|首页]]\n']),
    );

    assert.deepStrictEqual(g.nodes.map((n) => n.key), ['a.md']);
    assert.strictEqual(g.nodes[0]!.linkCount, 0, '指向 index/log 的链接不计入 linkCount');
    assert.strictEqual(g.edges.length, 0);
    assert.strictEqual(g.deadLinks.length, 0, '不产生死链');
  });

  it('isGraphExcludedFile is case-insensitive and only matches exact names', () => {
    assert.ok(isGraphExcludedFile('index.md'));
    assert.ok(isGraphExcludedFile('INDEX.md'));
    assert.ok(isGraphExcludedFile('log.md'));
    assert.ok(isGraphExcludedFile('Log.md'));
    assert.ok(!isGraphExcludedFile('index-x.md'));
    assert.ok(!isGraphExcludedFile('catalog.md'));
    assert.ok(!isGraphExcludedFile('login.md'));
  });
});

describe('buildGraph code-span handling (与 deadcheck 同口径)', () => {
  it('[[links]] inside fenced/inline code are literal text — no node, no edge, no dead link', () => {
    const g = buildGraph(
      makeVault([
        'a.md',
        '# A\n\n文档示例：\n\n```\n[[ghost-in-fence]] 与 [[b]]\n```\n\n行内 `[[ghost-inline]]` 代码。\n\n正文 [[b]]。\n',
      ], ['b.md', '# B\n']),
    );

    const keys = g.nodes.map((n) => n.key).sort();
    assert.deepStrictEqual(keys, ['a.md', 'b.md'], '代码里的 [[...]] 不产生死链节点');
    assert.strictEqual(g.deadLinks.length, 0);
    assert.strictEqual(g.edges.length, 1, '只有正文里那条 [[b]] 成边');
    const a = g.nodes.find((n) => n.key === 'a.md');
    assert.strictEqual(a!.linkCount, 1, 'linkCount 不被代码里的链接虚增');
  });

  it('quotes and frontmatter still count (rendered as links, checked by deadcheck)', () => {
    const g = buildGraph(
      makeVault([
        'a.md',
        '---\ntitle: "[[fm-ghost]]"\n---\n# A\n\n他说：「[[quote-ghost]]」。\n',
      ]),
    );

    const deadLabels = g.nodes.filter((n) => n.deadLink).map((n) => n.label).sort();
    assert.deepStrictEqual(deadLabels, ['fm-ghost', 'quote-ghost'], '引文/frontmatter 里的链接照常进图');
  });
});

describe('buildGraph unreadable-file resilience', () => {
  /**
   * 回归：wikilink 那遍的 readFileSync 曾经没有 try/catch（node-type 那遍有），
   * 于是单个读不了的文件会把异常冒到路由层 → 整张图 500。
   * Windows 上文件被占用（EBUSY/EPERM：同步盘、编辑器、杀软扫描）或移动盘休眠掉线
   * 都会命中；实测用户从移动硬盘加载知识库时图谱整体加载失败即此路径。
   */
  it('单个不可读文件不拖垮整张图：它仍是节点，其他文件的链接照常解析', () => {
    // Windows 的 chmod 不可靠；root 无视 0o000 → 两种环境下都跳过
    if (process.platform === 'win32' || process.getuid?.() === 0) return;

    const vaultPath = makeVault(
      ['readable.md', '# R\n\n[[ghost]]\n'],
      ['locked.md', '# L\n\n[[also-ghost]]\n'],
    );
    const locked = join(vaultPath, 'locked.md');
    chmodSync(locked, 0o000);

    try {
      const g = buildGraph(vaultPath); // 修复前：这里抛 EACCES

      assert.ok(g.nodes.some((n) => n.key === 'locked.md'), '不可读文件仍作为节点存在（与 node-type 那遍同口径）');
      assert.ok(g.nodes.some((n) => n.key === 'readable.md'), '可读文件不受影响');
      assert.ok(
        g.deadLinks.some((d) => d.targetName === 'ghost'),
        '可读文件的链接照常解析成死链',
      );
    } finally {
      chmodSync(locked, 0o644); // 还原，否则 after() 的 rmSync 清不掉
    }
  });
});
