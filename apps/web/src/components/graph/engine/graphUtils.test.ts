import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  clamp,
  easeCubicOut,
  dedupeEdges,
  makeAutoLinkStrength,
  computeFitTransform,
  greedyLabelLayout,
} from './graphUtils.ts';

/**
 * Unit tests for the graph engine's pure helpers.
 *
 * 这些函数从 pixiGraphEngine.ts 抽取，是边去重、力强度、相机适配的
 * 唯一实现——回归此文件即可守住引擎核心计算。
 */

// ── clamp ──

describe('clamp', () => {
  it('keeps values inside range untouched', () => {
    assert.strictEqual(clamp(5, 0, 10), 5);
    assert.strictEqual(clamp(0, 0, 10), 0);
    assert.strictEqual(clamp(10, 0, 10), 10);
  });

  it('clamps out-of-range values to the bounds', () => {
    assert.strictEqual(clamp(-3, 0, 10), 0);
    assert.strictEqual(clamp(42, 0, 10), 10);
  });
});

// ── easeCubicOut ──

describe('easeCubicOut', () => {
  it('maps endpoints exactly', () => {
    assert.strictEqual(easeCubicOut(0), 0);
    assert.strictEqual(easeCubicOut(1), 1);
  });

  it('is monotonic and front-loaded (fast start)', () => {
    const a = easeCubicOut(0.25);
    const b = easeCubicOut(0.5);
    const c = easeCubicOut(0.75);
    assert.ok(a < b && b < c, 'monotonic');
    // cubic-out at t=0.5 should already be past 0.75 of the distance
    assert.ok(b > 0.75, `expected ease(0.5) > 0.75, got ${b}`);
  });
});

// ── dedupeEdges ──

describe('dedupeEdges', () => {
  const exists = (keys: string[]) => {
    const s = new Set(keys);
    return (k: string) => s.has(k);
  };

  it('drops self-loops', () => {
    const out = dedupeEdges([{ source: 'a', target: 'a' }], exists(['a']));
    assert.deepStrictEqual(out, []);
  });

  it('drops edges with missing endpoints', () => {
    const out = dedupeEdges(
      [
        { source: 'a', target: 'ghost' },
        { source: 'ghost', target: 'b' },
        { source: 'a', target: 'b' },
      ],
      exists(['a', 'b']),
    );
    assert.deepStrictEqual(out, [{ source: 'a', target: 'b' }]);
  });

  it('dedupes undirected duplicates, keeping first direction', () => {
    const out = dedupeEdges(
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
        { source: 'a', target: 'b' },
      ],
      exists(['a', 'b']),
    );
    assert.deepStrictEqual(out, [{ source: 'a', target: 'b' }]);
  });

  it('keeps distinct edges intact', () => {
    const out = dedupeEdges(
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
      exists(['a', 'b', 'c']),
    );
    assert.strictEqual(out.length, 2);
  });
});

// ── makeAutoLinkStrength ──

describe('makeAutoLinkStrength', () => {
  it('returns 1/min(deg_s, deg_t) (d3 default)', () => {
    // hub "h" 连接 3 个叶子；叶子之间无连接
    const adjacency = new Map<string, Set<string>>([
      ['h', new Set(['l1', 'l2', 'l3'])],
      ['l1', new Set(['h'])],
      ['l2', new Set(['h'])],
      ['l3', new Set(['h'])],
    ]);
    const strength = makeAutoLinkStrength(adjacency);

    // hub→leaf：1/min(3,1) = 1（叶子侧度数 1 主导）
    assert.strictEqual(strength({ sourceKey: 'h', targetKey: 'l1' }), 1);
    // leaf→leaf（假想边）：1/min(1,1) = 1
    assert.strictEqual(strength({ sourceKey: 'l1', targetKey: 'l2' }), 1);
  });

  it('softens links between two hubs', () => {
    const adjacency = new Map<string, Set<string>>([
      ['h1', new Set(['a', 'b', 'c', 'h2'])],
      ['h2', new Set(['d', 'e', 'h1'])],
      ['a', new Set(['h1'])],
      ['b', new Set(['h1'])],
      ['c', new Set(['h1'])],
      ['d', new Set(['h2'])],
      ['e', new Set(['h2'])],
    ]);
    const strength = makeAutoLinkStrength(adjacency);
    // h1(deg4)–h2(deg3)：1/min(4,3) = 1/3 → hub 间连线变软
    assert.ok(Math.abs(strength({ sourceKey: 'h1', targetKey: 'h2' }) - 1 / 3) < 1e-9);
  });

  it('treats missing adjacency entries as degree 1 (no crash)', () => {
    const strength = makeAutoLinkStrength(new Map());
    assert.strictEqual(strength({ sourceKey: 'x', targetKey: 'y' }), 1);
  });
});

// ── computeFitTransform ──

describe('computeFitTransform', () => {
  it('centers the bounds on screen', () => {
    const { tx, ty, k } = computeFitTransform(
      { minX: -100, maxX: 100, minY: -50, maxY: 50 },
      800,
      600,
      80,
      0.05,
      8,
    );
    // 图中心 (0,0) 应映射到屏幕中心 (400,300)
    assert.ok(Math.abs(0 * k + tx - 400) < 1e-9);
    assert.ok(Math.abs(0 * k + ty - 300) < 1e-9);
  });

  it('fits the limiting dimension with padding', () => {
    // 宽 200 高 100 的图，屏幕 800×600，pad 80
    // 宽度约束：(800-160)/200 = 3.2；高度约束：(600-160)/100 = 4.4 → 取小
    const { k } = computeFitTransform(
      { minX: 0, maxX: 200, minY: 0, maxY: 100 },
      800,
      600,
      80,
      0.05,
      8,
    );
    assert.ok(Math.abs(k - 3.2) < 1e-9, `expected k=3.2, got ${k}`);
  });

  it('clamps k to kMin for huge graphs', () => {
    const { k } = computeFitTransform(
      { minX: 0, maxX: 100_000, minY: 0, maxY: 100_000 },
      800,
      600,
      80,
      0.05,
      8,
    );
    assert.strictEqual(k, 0.05);
  });

  it('clamps k to kMax for tiny graphs', () => {
    const { k } = computeFitTransform(
      { minX: 0, maxX: 1, minY: 0, maxY: 1 },
      800,
      600,
      80,
      0.05,
      8,
    );
    assert.strictEqual(k, 8);
  });

  it('handles degenerate bounds (zero-area) without NaN', () => {
    const { tx, ty, k } = computeFitTransform(
      { minX: 5, maxX: 5, minY: 5, maxY: 5 },
      800,
      600,
      80,
      0.05,
      8,
    );
    assert.ok(Number.isFinite(k) && Number.isFinite(tx) && Number.isFinite(ty));
  });
});

// ── greedyLabelLayout（Obsidian 式标签去重）──

describe('greedyLabelLayout', () => {
  const box = (x: number, y: number, w = 20, h = 10) => ({ x0: x, y0: y, x1: x + w, y1: y + h });

  it('shows all labels when none overlap', () => {
    const visible = greedyLabelLayout([box(0, 0), box(30, 0), box(0, 30)]);
    assert.deepStrictEqual(visible, [true, true, true]);
  });

  it('drops later labels that overlap an earlier (higher-priority) one', () => {
    // 第二个框与第一个重叠 → 被剔除；第三个独立 → 保留
    const visible = greedyLabelLayout([box(0, 0), box(5, 2), box(100, 100)]);
    assert.deepStrictEqual(visible, [true, false, true]);
  });

  it('transitively frees space: a dropped label does not occupy space', () => {
    // A=[0,20]×[0,10] 与 B=[5,25]×[2,12] 重叠（B 被剔除）；
    // C=[22,42]×[8,18] 与 B 重叠但 B 已不占位，与 A 不重叠 → C 显示
    const visible = greedyLabelLayout([box(0, 0), box(5, 2), box(22, 8)]);
    assert.deepStrictEqual(visible, [true, false, true]);
  });

  it('pinned labels always show even when overlapping, and occupy space', () => {
    // 焦点标签（pinned）互相允许重叠；后续普通标签与焦点标签重叠则被剔除
    const visible = greedyLabelLayout(
      [box(0, 0), box(2, 2), box(3, 3)],
      [true, true, false],
    );
    assert.deepStrictEqual(visible, [true, true, false]);
  });

  it('guarantees no two non-pinned visible boxes overlap', () => {
    const boxes = [
      box(0, 0), box(10, 0), box(20, 0), box(30, 0), box(5, 5), box(15, 5), box(40, 40),
    ];
    const visible = greedyLabelLayout(boxes);
    const shown = boxes.filter((_, i) => visible[i]);
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i]!;
        const b = shown[j]!;
        const overlaps = a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
        assert.ok(!overlaps, `boxes ${i} and ${j} overlap among visible labels`);
      }
    }
  });

  it('touching boxes (shared edge) do not count as overlap', () => {
    const visible = greedyLabelLayout([box(0, 0), box(20, 0)]);
    assert.deepStrictEqual(visible, [true, true]);
  });
});
