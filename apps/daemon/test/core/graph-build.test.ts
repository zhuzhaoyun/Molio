import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { buildGraph } from '../../src/core/graph-build.js';

/**
 * core/graph-build.ts 的实现不变量（与 test/routes/graph.test.ts 的解析行为测试互补）。
 *
 * 这里的判据是「读了几次盘」——行为测试看不出这个：旧实现每个 md 读两遍（一遍
 * 只为 frontmatter 判类型，一遍解析 wikilink），图长得一模一样，但大库（6.5k md /
 * 110MB）白付一倍 IO。合并后必须每个文件恰好读一次，且类型/链接都还对。
 */

const dirs: string[] = [];

function makeVault(...files: Array<[rel: string, content: string]>): string {
  const d = mkdtempSync(join(tmpdir(), 'molio-graph-build-'));
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

describe('buildGraph 读盘次数', () => {
  it('每个 md 只读一次（类型与链接共用同一次读取）', () => {
    const vault = makeVault(
      ['a.md', '---\ntype: concept\n---\n\n# A\n\n[[b]]\n'],
      ['b.md', '# B\n\n[[ghost]]\n'],
      ['dir/c.md', '# C\n\n[[a]]\n'],
    );

    const reads = new Map<string, number>();
    const g = buildGraph(vault, {
      readFile: (absPath) => {
        reads.set(absPath, (reads.get(absPath) ?? 0) + 1);
        return readFileSync(absPath, 'utf-8');
      },
    });

    assert.deepEqual(
      [...reads.entries()].filter(([, n]) => n > 1),
      [],
      '任何 md 被读超过一次都说明双读又回来了',
    );
    assert.equal(reads.size, 3, '三个 md 各读一次');

    // 单次读取仍要同时喂饱两条用途：frontmatter 类型 + 链接解析
    assert.equal(g.nodes.find((n) => n.key === 'a.md')?.nodeType, 'concept');
    assert.equal(g.nodes.find((n) => n.key === 'b.md')?.nodeType, 'document');
    assert.equal(g.nodes.find((n) => n.key === 'dir/c.md')?.nodeType, 'document');
    // 边按「无序对」比较：内部用 min→max 做去重键，方向不代表语义
    assert.deepEqual(
      g.edges.map((e) => [e.source, e.target].sort().join('|')).sort(),
      ['__dead__ghost|b.md', 'a.md|b.md', 'a.md|dir/c.md'].sort(),
    );
    assert.deepEqual(g.deadLinks.map((d) => d.targetName), ['ghost']);
  });

  it('模糊匹配：[[AI Safety]] 命中 ai-safety.md（预建归一化索引与线性扫描等价）', () => {
    const vault = makeVault(
      ['ai-safety.md', '# A\n'],
      ['note.md', '# N\n\n[[AI Safety]]\n[[概念/知识库]]\n'],
      ['概念/知识库.md', '# K\n'],
    );

    const g = buildGraph(vault);
    // Case 3：[[AI Safety]] 归一化成 aisafety，命中 ai-safety.md
    assert.ok(g.edges.some((e) => [e.source, e.target].sort().join('|') === 'ai-safety.md|note.md'));
    // 带目录前缀的链接按 basename 命中（Case 2，先于模糊匹配）
    assert.ok(g.edges.some((e) => [e.source, e.target].sort().join('|') === 'note.md|概念/知识库.md'));
    assert.deepEqual(g.deadLinks, [], '两条链接都该解析成功，不该退化成死链');
  });

  it('读失败的文件仍留在图里，类型按路径推断（读盘合并后不丢这条韧性）', () => {
    const vault = makeVault(
      ['wiki/concepts/locked.md', '# L\n\n[[a]]\n'],
      ['a.md', '# A\n\n[[locked]]\n'],
    );

    const g = buildGraph(vault, {
      readFile: (absPath) => {
        if (absPath.endsWith('locked.md')) throw new Error('EBUSY');
        return readFileSync(absPath, 'utf-8');
      },
    });

    const locked = g.nodes.find((n) => n.key === 'wiki/concepts/locked.md');
    assert.ok(locked, '不可读文件仍是节点');
    assert.equal(locked.nodeType, 'concept', '类型回落到按路径推断');
    // 读不了 → 它的出边没有；但别的文件指向它的边照常存在
    assert.ok(g.edges.some((e) => e.source === 'a.md' && e.target === 'wiki/concepts/locked.md'));
  });
});
