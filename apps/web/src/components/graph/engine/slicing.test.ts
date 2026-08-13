import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { GraphData } from '@molio/contracts';
import {
  DEAD_PREFIX,
  EGO_MAX_DEPTH,
  normalizeGraphData,
  egoSlice,
  mergeGraphData,
  evictBloomOverflow,
  computeFrontier,
  overviewTopN,
  computeHiddenNeighbors,
  undirectedEdgeKey,
} from './slicing.ts';

/**
 * 固定 fixture：
 *   a ─ b, a ─ c, c ─ d, a ── [[ghost]]（死链）, e 孤立
 * 全图度数：a=3(b,c,ghost) b=1 c=2(a,d) d=1 ghost=1 e=0
 */
function fixture(): GraphData {
  return {
    nodes: [
      { key: 'a', label: 'a', path: 'a.md', linkCount: 3 },
      { key: 'b', label: 'b', path: 'b.md', linkCount: 1 },
      { key: 'c', label: 'c', path: 'c.md', linkCount: 2 },
      { key: 'd', label: 'd', path: 'd.md', linkCount: 1 },
      { key: 'e', label: 'e', path: 'e.md', linkCount: 0 },
    ],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'c', target: 'd' },
    ],
    deadLinks: [{ sourceFile: 'a', targetName: 'ghost' }],
  };
}

describe('normalizeGraphData', () => {
  it('synthesizes dead nodes with reference count and (?) label', () => {
    const full = normalizeGraphData(fixture());
    const ghost = full.nodeMap.get(DEAD_PREFIX + 'ghost');
    assert.ok(ghost, 'ghost node exists');
    assert.strictEqual(ghost.deadLink, true);
    assert.strictEqual(ghost.linkCount, 1);
    assert.strictEqual(ghost.label, 'ghost (?)');
  });

  it('dedupes dead links by targetName and counts references', () => {
    const data = fixture();
    data.deadLinks.push({ sourceFile: 'c', targetName: 'ghost' });
    const full = normalizeGraphData(data);
    const deadKeys = Array.from(full.nodeMap.keys()).filter((k) => k.startsWith(DEAD_PREFIX));
    assert.strictEqual(deadKeys.length, 1);
    assert.strictEqual(full.nodeMap.get(DEAD_PREFIX + 'ghost')!.linkCount, 2);
  });

  it('creates synthetic edges from source file to dead node', () => {
    const full = normalizeGraphData(fixture());
    assert.deepStrictEqual(full.adjacency.get('a'), new Set(['b', 'c', DEAD_PREFIX + 'ghost']));
    assert.deepStrictEqual(full.adjacency.get(DEAD_PREFIX + 'ghost'), new Set(['a']));
  });

  it('dedupes edges ignoring direction and skips self loops / dangling endpoints', () => {
    const data = fixture();
    data.edges.push({ source: 'b', target: 'a' }); // reverse duplicate
    data.edges.push({ source: 'a', target: 'a' }); // self loop
    data.edges.push({ source: 'a', target: 'missing' }); // dangling (not a deadLink)
    const full = normalizeGraphData(data);
    const keys = full.edges.map((e) => undirectedEdgeKey(e.source, e.target));
    assert.strictEqual(keys.length, new Set(keys).size, 'no duplicate edges');
    assert.strictEqual(full.edges.length, 4); // a-b, a-c, c-d, a-ghost
    assert.ok(!full.edges.some((e) => e.source === e.target), 'no self loops');
  });
});

describe('egoSlice', () => {
  it('depth 1 returns center plus direct neighbors and internal edges', () => {
    const full = normalizeGraphData(fixture());
    const slice = egoSlice(full, 'a', 1);
    const keys = slice.nodes.map((n) => n.key).sort();
    assert.deepStrictEqual(keys, [DEAD_PREFIX + 'ghost', 'a', 'b', 'c'].sort());
    const edgeKeys = slice.edges.map((e) => undirectedEdgeKey(e.source, e.target)).sort();
    assert.deepStrictEqual(
      edgeKeys,
      [undirectedEdgeKey('a', 'b'), undirectedEdgeKey('a', 'c'), undirectedEdgeKey('a', DEAD_PREFIX + 'ghost')].sort(),
    );
  });

  it('depth 2 reaches neighbors of neighbors', () => {
    const full = normalizeGraphData(fixture());
    const slice = egoSlice(full, 'a', 2);
    const keys = new Set(slice.nodes.map((n) => n.key));
    assert.ok(keys.has('d'), 'd is 2 hops away via c');
    assert.ok(!keys.has('e'), 'isolated e never reachable');
    assert.ok(slice.edges.some((e) => undirectedEdgeKey(e.source, e.target) === undirectedEdgeKey('c', 'd')));
  });

  it('clamps depth to EGO_MAX_DEPTH', () => {
    const full = normalizeGraphData(fixture());
    const deep = egoSlice(full, 'a', 99);
    const clamped = egoSlice(full, 'a', EGO_MAX_DEPTH);
    assert.deepStrictEqual(
      deep.nodes.map((n) => n.key).sort(),
      clamped.nodes.map((n) => n.key).sort(),
    );
  });

  it('unknown center returns empty canvas', () => {
    const full = normalizeGraphData(fixture());
    assert.deepStrictEqual(egoSlice(full, 'nope'), { nodes: [], edges: [] });
  });

  it('isolated node ego slice contains only itself', () => {
    const full = normalizeGraphData(fixture());
    const slice = egoSlice(full, 'e', 1);
    assert.strictEqual(slice.nodes.length, 1);
    assert.strictEqual(slice.nodes[0].key, 'e');
    assert.strictEqual(slice.edges.length, 0);
  });
});

describe('mergeGraphData', () => {
  it('dedupes nodes by key and edges ignoring direction', () => {
    const full = normalizeGraphData(fixture());
    const base = egoSlice(full, 'a', 1);
    // incoming 携带反向重复边（B-A）与已存在节点
    const incoming = {
      nodes: [full.nodeMap.get('a')!, full.nodeMap.get('d')!, full.nodeMap.get('c')!],
      edges: [
        { source: 'b', target: 'a' }, // 与 base 的 a-b 重复（无向）
        { source: 'c', target: 'd' }, // 新边
      ],
    };
    const generations = new Map<string, number>();
    for (const n of base.nodes) generations.set(n.key, 0);
    const merged = mergeGraphData(base, incoming, 1, generations);

    assert.strictEqual(merged.nodes.length, 5, 'a b c ghost d');
    const edgeKeys = merged.edges.map((e) => undirectedEdgeKey(e.source, e.target));
    assert.strictEqual(edgeKeys.length, new Set(edgeKeys).size, 'no duplicate edges');
    assert.ok(edgeKeys.includes(undirectedEdgeKey('c', 'd')), 'new edge kept');
  });

  it('tags only newly arrived nodes with the new generation', () => {
    const full = normalizeGraphData(fixture());
    const base = egoSlice(full, 'a', 1);
    const incoming = egoSlice(full, 'c', 1);
    const generations = new Map<string, number>();
    for (const n of base.nodes) generations.set(n.key, 0);
    mergeGraphData(base, incoming, 3, generations);
    assert.strictEqual(generations.get('d'), 3, 'new node tagged gen 3');
    assert.strictEqual(generations.get('a'), 0, 'existing node keeps gen 0');
  });
});

describe('evictBloomOverflow', () => {
  it('returns data unchanged under the cap', () => {
    const full = normalizeGraphData(fixture());
    const canvas = egoSlice(full, 'a', 2);
    const generations = new Map<string, number>();
    const out = evictBloomOverflow(canvas, new Set(), generations, 100);
    assert.strictEqual(out, canvas);
  });

  it('evicts oldest generations first, protecting gen-0 and protect set', () => {
    const full = normalizeGraphData(fixture());
    const base = egoSlice(full, 'a', 1); // gen 0: a b c ghost
    const generations = new Map<string, number>();
    for (const n of base.nodes) generations.set(n.key, 0);

    // gen1 加入 d；gen2 加入 e（构造一个手工 incoming）
    const gen1 = mergeGraphData(base, { nodes: [full.nodeMap.get('d')!], edges: [{ source: 'c', target: 'd' }] }, 1, generations);
    const gen2 = mergeGraphData(gen1, { nodes: [full.nodeMap.get('e')!], edges: [] }, 2, generations);

    // cap=5：只需驱逐 1 个 → 最老可驱逐代际 gen1 的 d
    const out = evictBloomOverflow(gen2, new Set(['a']), generations, 5);
    const keys = new Set(out.nodes.map((n) => n.key));
    assert.strictEqual(out.nodes.length, 5);
    assert.ok(!keys.has('d'), 'gen-1 node evicted first');
    assert.ok(keys.has('e'), 'newer gen survives this round');
    assert.ok(keys.has('a') && keys.has('b') && keys.has('c'), 'gen-0 never evicted');
    assert.ok(!out.edges.some((e) => e.source === 'd' || e.target === 'd'), 'evicted node edges removed');
    assert.ok(!generations.has('d'), 'generation entry cleaned up');
  });

  it('never evicts protected keys even when they are oldest', () => {
    const full = normalizeGraphData(fixture());
    const base = egoSlice(full, 'a', 1);
    const generations = new Map<string, number>();
    for (const n of base.nodes) generations.set(n.key, 0);
    const gen1 = mergeGraphData(base, { nodes: [full.nodeMap.get('d')!], edges: [{ source: 'c', target: 'd' }] }, 1, generations);
    // protect d → 没有可驱逐对象，保持原样
    const out = evictBloomOverflow(gen1, new Set(['a', 'b', 'c', 'd', DEAD_PREFIX + 'ghost']), generations, 2);
    assert.strictEqual(out.nodes.length, gen1.nodes.length);
  });
});

describe('computeFrontier', () => {
  it('lists nodes with hidden neighbors, excluding center and dead nodes', () => {
    const full = normalizeGraphData(fixture());
    const canvas = egoSlice(full, 'a', 1); // a b c ghost —— b 的画布度=1=全图度；c 缺 d
    const frontier = computeFrontier(canvas, full, 'a');
    assert.deepStrictEqual(frontier, ['c']);
  });

  it('full canvas has no frontier', () => {
    const full = normalizeGraphData(fixture());
    const canvas = { nodes: Array.from(full.nodeMap.values()), edges: full.edges };
    assert.deepStrictEqual(computeFrontier(canvas, full, ''), []);
  });
});

describe('overviewTopN', () => {
  const always = () => true;

  it('below cap returns everything untruncated', () => {
    const full = normalizeGraphData(fixture());
    const { data, truncated } = overviewTopN(full, always, 100);
    assert.strictEqual(truncated, false);
    assert.strictEqual(data.nodes.length, full.nodeMap.size);
  });

  it('above cap keeps top linkCount with real nodes ahead of dead ties', () => {
    const full = normalizeGraphData(fixture());
    // cap=4：a(3) c(2) 必进；linkCount=1 的有 b/d/ghost 三个 → 真实节点 b、d 优先于 ghost
    const { data, truncated } = overviewTopN(full, always, 4);
    assert.strictEqual(truncated, true);
    const keys = new Set(data.nodes.map((n) => n.key));
    assert.deepStrictEqual([...keys].sort(), ['a', 'b', 'c', 'd'].sort());
    assert.ok(!keys.has(DEAD_PREFIX + 'ghost'), 'dead node loses the tie to real nodes');
  });

  it('keeps only edges whose endpoints both survived the cut', () => {
    const full = normalizeGraphData(fixture());
    const { data } = overviewTopN(full, always, 2); // a(3), c(2)
    const edgeKeys = data.edges.map((e) => undirectedEdgeKey(e.source, e.target));
    assert.deepStrictEqual(edgeKeys, [undirectedEdgeKey('a', 'c')]);
  });

  it('respects the visibility predicate', () => {
    const full = normalizeGraphData(fixture());
    const noDeadNoOrphan = (n: { deadLink?: boolean; linkCount: number }) =>
      !n.deadLink && n.linkCount > 0;
    const { data } = overviewTopN(full, noDeadNoOrphan, 100);
    const keys = new Set(data.nodes.map((n) => n.key));
    assert.ok(!keys.has(DEAD_PREFIX + 'ghost'));
    assert.ok(!keys.has('e'));
    assert.strictEqual(data.edges.length, 3);
  });
});

describe('computeHiddenNeighbors', () => {
  it('full canvas without truncation has zero hidden neighbors', () => {
    const full = normalizeGraphData(fixture());
    const canvas = { nodes: Array.from(full.nodeMap.values()), edges: full.edges };
    const hidden = computeHiddenNeighbors(canvas, full);
    for (const v of hidden.values()) assert.strictEqual(v, 0);
  });

  it('ego slice reports hidden neighbors; dead nodes always 0', () => {
    const full = normalizeGraphData(fixture());
    const canvas = egoSlice(full, 'a', 1); // c 缺 d → hidden 1
    const hidden = computeHiddenNeighbors(canvas, full);
    assert.strictEqual(hidden.get('c'), 1);
    assert.strictEqual(hidden.get('a'), 0);
    assert.strictEqual(hidden.get(DEAD_PREFIX + 'ghost'), 0);
  });
});
