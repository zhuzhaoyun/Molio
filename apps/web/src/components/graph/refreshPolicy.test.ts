import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { GraphData } from '@molio/contracts';
import { graphFingerprint, refreshDebounceMs } from './refreshPolicy.ts';

/**
 * 图谱刷新策略的纯函数测试。
 *
 * 两个函数分别回答自动刷新的两个问题：
 *   1. graphFingerprint —— 「这次取回来的数据跟上次一样吗？」一样就不重建。
 *      没有它，往 raw/ 拷个 PDF、改个错别字都会重跑一遍 300 ticks 的力导向仿真
 *      （实测 1445 节点 ≈ 2.9s CPU）。
 *   2. refreshDebounceMs —— 「等多久再刷？」大图重排代价高，值得多等一会儿把
 *      AI 连续写入的多波信号合并成一次。
 */

function makeGraph(over: Partial<GraphData> = {}): GraphData {
  return {
    nodes: [
      { key: 'a.md', label: 'a', path: 'a.md', linkCount: 1 },
      { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
    ],
    edges: [{ source: 'a.md', target: 'b.md' }],
    ...over,
  } as GraphData;
}

describe('graphFingerprint', () => {
  it('两份内容相同但对象不同的数据，指纹相同', () => {
    assert.strictEqual(graphFingerprint(makeGraph()), graphFingerprint(makeGraph()));
  });

  it('节点/边的数组顺序不同 ⇒ 指纹仍相同（readdir 顺序会随目录内容变化）', () => {
    const ordered = makeGraph({
      nodes: [
        { key: 'a.md', label: 'a', path: 'a.md', linkCount: 1 },
        { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
        { key: 'c.md', label: 'c', path: 'c.md', linkCount: 2 },
      ],
      edges: [
        { source: 'a.md', target: 'b.md' },
        { source: 'c.md', target: 'a.md' },
      ],
    } as Partial<GraphData>);
    const shuffled = makeGraph({
      nodes: [
        { key: 'c.md', label: 'c', path: 'c.md', linkCount: 2 },
        { key: 'a.md', label: 'a', path: 'a.md', linkCount: 1 },
        { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
      ],
      edges: [
        { source: 'c.md', target: 'a.md' },
        { source: 'a.md', target: 'b.md' },
      ],
    } as Partial<GraphData>);
    assert.strictEqual(graphFingerprint(ordered), graphFingerprint(shuffled));
  });

  it('新增节点 ⇒ 指纹变', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({
      nodes: [
        { key: 'a.md', label: 'a', path: 'a.md', linkCount: 1 },
        { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
        { key: 'c.md', label: 'c', path: 'c.md', linkCount: 0 },
      ],
    } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('新增边 ⇒ 指纹变', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({
      edges: [
        { source: 'a.md', target: 'b.md' },
        { source: 'b.md', target: 'a.md' },
      ],
    } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('节点度数变化 ⇒ 指纹变（多/少一条入边，但边集不变的情形）', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({
      nodes: [
        { key: 'a.md', label: 'a', path: 'a.md', linkCount: 5 },
        { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
      ],
    } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('节点类型变化 ⇒ 指纹变（影响节点颜色/筛选）', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({
      nodes: [
        { key: 'a.md', label: 'a', path: 'a.md', linkCount: 1, nodeType: 'concept' },
        { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
      ],
    } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('死链标记变化 ⇒ 指纹变（影响是否渲染为死链节点）', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({
      nodes: [
        { key: 'a.md', label: 'a', path: 'a.md', linkCount: 1, deadLink: true },
        { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
      ],
    } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('标签变化 ⇒ 指纹变（渲染文本变了）', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({
      nodes: [
        { key: 'a.md', label: 'a（改名）', path: 'a.md', linkCount: 1 },
        { key: 'b.md', label: 'b', path: 'b.md', linkCount: 1 },
      ],
    } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('focusNodes 变化 ⇒ 指纹变（局部图要重新选中圆心）', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({ focusNodes: ['a.md'] } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('死链数量变化 ⇒ 指纹变（统计弹层显示条数）', () => {
    const before = graphFingerprint(makeGraph());
    const after = graphFingerprint(makeGraph({
      deadLinks: [{ sourceFile: 'b.md', targetName: 'ghost' }],
    } as Partial<GraphData>));
    assert.notStrictEqual(before, after);
  });

  it('键名里含分隔符也不串味（a|b 与 a 加 b 不能同指纹）', () => {
    const left = graphFingerprint(makeGraph({
      nodes: [{ key: 'a|b', label: 'x', path: 'a|b', linkCount: 1 }],
      edges: [],
    } as Partial<GraphData>));
    const right = graphFingerprint(makeGraph({
      nodes: [
        { key: 'a', label: 'x', path: 'a', linkCount: 1 },
        { key: 'b', label: 'x', path: 'b', linkCount: 1 },
      ],
      edges: [],
    } as Partial<GraphData>));
    assert.notStrictEqual(left, right);
  });
});

describe('refreshDebounceMs', () => {
  it('小图（≤300 节点）用基础延迟 400ms', () => {
    assert.strictEqual(refreshDebounceMs(0), 400);
    assert.strictEqual(refreshDebounceMs(9), 400);
    assert.strictEqual(refreshDebounceMs(300), 400);
  });

  it('中图（301–800）加长到 800ms', () => {
    assert.strictEqual(refreshDebounceMs(301), 800);
    assert.strictEqual(refreshDebounceMs(694), 800);
    assert.strictEqual(refreshDebounceMs(800), 800);
  });

  it('大图（>800）加长到 1500ms', () => {
    assert.strictEqual(refreshDebounceMs(801), 1500);
    assert.strictEqual(refreshDebounceMs(1445), 1500);
  });

  it('延迟随规模单调不减', () => {
    const sizes = [0, 100, 300, 301, 800, 801, 5000];
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(
        refreshDebounceMs(sizes[i]!) >= refreshDebounceMs(sizes[i - 1]!),
        `${sizes[i]} 的延迟不该小于 ${sizes[i - 1]}`,
      );
    }
  });
});
