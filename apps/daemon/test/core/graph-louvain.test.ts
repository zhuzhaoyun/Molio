import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { louvainCommunities, seededRandom } from '../../src/core/graph-louvain.js';

/**
 * core/graph-louvain.ts 的行为约定测试（设计 docs/2026-11-27-graph-community-hierarchy-design.md §四）。
 *
 * fixture 用「团（clique）」形状——Louvain 的模块度对团内互连/团间弱连的划分是稳定解，
 * 断言才可依赖。确定性是硬要求：同输入两次运行逐字段相等（设计 Global Constraints）。
 */

function clique(prefix: string, n: number): { keys: string[]; edges: Array<{ source: string; target: string; weight: number }> } {
  const keys = Array.from({ length: n }, (_, i) => `${prefix}${i}.md`);
  const edges: Array<{ source: string; target: string; weight: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      edges.push({ source: keys[i]!, target: keys[j]!, weight: 1 });
    }
  }
  return { keys, edges };
}

describe('louvainCommunities', () => {
  it('two dense clusters with one bridge split into two communities', () => {
    const a = clique('a/', 6);
    const b = clique('b/', 6);
    const groups = louvainCommunities([...a.keys, ...b.keys], [
      ...a.edges,
      ...b.edges,
      { source: 'a/0.md', target: 'b/0.md', weight: 1 },
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups.map((g) => g.length).sort((x, y) => x - y),
      [6, 6],
    );
    // 组间按最小 key 排序、组内按 key 排序
    assert.deepEqual(groups[0], [...a.keys].sort());
    assert.deepEqual(groups[1], [...b.keys].sort());
  });

  it('parallel edges accumulate weight', () => {
    // 共享节点 a 以权 3 连向 X 团、权 1 连向 Y 团（两团对称）——平行边累计后
    // a 必须落权重大的 X 侧。（3 节点小图上模块度倾向全并，区分不了权重——
    // 计划原 fixture 前提错误，Ruling 见 ledger。）
    const x = clique('b/', 4);
    const y = clique('c/', 4);
    const groups = louvainCommunities(['a.md', ...x.keys, ...y.keys], [
      ...x.edges,
      ...y.edges,
      { source: 'a.md', target: 'b/0.md', weight: 3 },
      { source: 'a.md', target: 'c/0.md', weight: 1 },
    ]);
    const groupOf = new Map<string, number>();
    groups.forEach((g, gi) => g.forEach((k) => groupOf.set(k, gi)));
    assert.equal(groupOf.get('a.md'), groupOf.get('b/0.md'));
    assert.notEqual(groupOf.get('a.md'), groupOf.get('c/0.md'));
  });

  it('deterministic across runs', () => {
    const a = clique('x/', 8);
    const b = clique('y/', 8);
    const c = clique('z/', 5);
    const keys = [...a.keys, ...b.keys, ...c.keys];
    const edges = [
      ...a.edges,
      ...b.edges,
      ...c.edges,
      { source: 'x/0.md', target: 'y/0.md', weight: 1 },
      { source: 'y/1.md', target: 'z/1.md', weight: 1 },
    ];
    assert.deepEqual(louvainCommunities(keys, edges), louvainCommunities(keys, edges));
  });

  it('disconnected and single-node inputs are valid', () => {
    const groups = louvainCommunities(['solo.md', 'p.md', 'q.md'], [
      { source: 'p.md', target: 'q.md', weight: 1 },
    ]);
    const seen = groups.flat().sort();
    assert.deepEqual(seen, ['p.md', 'q.md', 'solo.md']);
    // 空/单节点输入不抛错
    assert.deepEqual(louvainCommunities([], []), []);
    assert.deepEqual(louvainCommunities(['only.md'], []), [['only.md']]);
  });

  it('seededRandom returns the same fixed sequence', () => {
    const r1 = seededRandom();
    const r2 = seededRandom();
    const s1 = Array.from({ length: 5 }, () => r1());
    const s2 = Array.from({ length: 5 }, () => r2());
    assert.deepEqual(s1, s2);
  });
});
