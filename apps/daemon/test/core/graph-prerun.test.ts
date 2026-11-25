import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPrerun, stepPrerun, inheritOverlap } from '../../src/core/graph-prerun.js';

/**
 * H3 Task 3：daemon 侧布局预跑（纯模块，node:test 直测）。
 *
 * 预跑 = 在 worker 线程里用**与浏览器引擎同款**的力配方（contracts 单一来源）
 * 把布局算到 alpha 耗尽，产出近终态坐标作浏览器种子。分片推进（stepPrerun）
 * 是可抢占性的前提：每片同步 ≤maxTicks，片间让出事件循环服务排队任务。
 */

/** 确定性 LCG（与仓库其他基准脚本同法） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 两簇互链确定性图：clusterA(30) 内聚 + clusterB(30) 内聚 + 少量跨簇边 */
function twoClusterGraph() {
  const keys: string[] = [];
  const links: Array<{ source: string; target: string }> = [];
  const degrees = new Map<string, number>();
  const bump = (k: string) => degrees.set(k, (degrees.get(k) ?? 0) + 1);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 30; i++) keys.push(`c${c}/n${String(i).padStart(2, '0')}.md`);
  }
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 30; i++) {
      const a = keys[c * 30 + i]!;
      const b = keys[c * 30 + ((i + 1) % 30)]!;
      links.push({ source: a, target: b });
      bump(a); bump(b);
    }
  }
  for (let i = 0; i < 4; i++) {
    links.push({ source: keys[i]!, target: keys[30 + i]! });
    bump(keys[i]!); bump(keys[30 + i]!);
  }
  return { keys, links, degrees };
}

/** 无结构随机图（degenerate 单巨团形态）：40 节点、每对以 0.05 概率连边 */
function randomGraph() {
  const rnd = lcg(20261125);
  const keys = Array.from({ length: 40 }, (_, i) => `散${String(i).padStart(2, '0')}.md`);
  const links: Array<{ source: string; target: string }> = [];
  const degrees = new Map<string, number>();
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      if (rnd() < 0.05) {
        const a = keys[i]!;
        const b = keys[j]!;
        links.push({ source: a, target: b });
        degrees.set(a, (degrees.get(a) ?? 0) + 1);
        degrees.set(b, (degrees.get(b) ?? 0) + 1);
      }
  return { keys, links, degrees };
}

describe('createPrerun/stepPrerun（全量预跑）', () => {
  it('两簇图：分片跑到 done，positions 覆盖全部键、坐标有限且已取整 1 位', () => {
    const { keys, links, degrees } = twoClusterGraph();
    const state = createPrerun(keys, links, degrees);
    let result = { done: false, positions: [] as Array<[string, number, number]> };
    let steps = 0;
    while (!result.done && steps < 100) {
      result = stepPrerun(state, 40);
      steps++;
    }
    assert.ok(result.done, `应在 100 片内 done（实际 steps=${steps}）`);
    assert.equal(result.positions.length, 60);
    const keySet = new Set(keys);
    for (const [k, x, y] of result.positions) {
      assert.ok(keySet.has(k), `未知键 ${k}`);
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `${k} 坐标非有限数`);
      // 取整 1 位：×10 后必为整数
      assert.equal(Math.round(x * 10), x * 10, `${k}.x 未取整 1 位`);
      assert.equal(Math.round(y * 10), y * 10, `${k}.y 未取整 1 位`);
    }
  });

  it('无结构图（degenerate 单巨团）：同样产出全量 positions', () => {
    const { keys, links, degrees } = randomGraph();
    const state = createPrerun(keys, links, degrees);
    let result = { done: false, positions: [] as Array<[string, number, number]> };
    let steps = 0;
    while (!result.done && steps < 100) {
      result = stepPrerun(state, 40);
      steps++;
    }
    assert.ok(result.done);
    assert.equal(result.positions.length, 40);
    for (const [, x, y] of result.positions) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  });

  it('增量继承（重叠 0.6）：500 ticks 内 done，新节点拿到有限坐标', () => {
    const { keys, links, degrees } = twoClusterGraph();
    // 旧位置：36/60 命中（0.6 重叠），其余 24 个键改名视为新节点
    const inherit = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < 36; i++) inherit.set(keys[i]!, { x: (i % 7) * 13.5, y: (i % 11) * -9.25 });
    const state = createPrerun(keys, links, degrees, inherit);
    assert.equal(state.inheritHitRatio, 0.6);
    // 增量档：α=0.3/decay=0.06 → ln(0.001/0.3)/ln(0.94) ≈ 87 ticks
    assert.equal(state.alphaStart, 0.3);
    const full = createPrerun(keys, links, degrees);
    assert.equal(full.alphaStart, 1);
    let result = { done: false, positions: [] as Array<[string, number, number]> };
    let totalTicks = 0;
    while (!result.done && totalTicks < 500) {
      result = stepPrerun(state, 40);
      totalTicks += 40;
    }
    assert.ok(result.done, '增量档应在 500 ticks 内 done');
    assert.equal(result.positions.length, 60);
    for (const [, x, y] of result.positions) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  });
});

describe('inheritOverlap', () => {
  it('重叠率 = 新键 ∩ 旧键 / 新键数', () => {
    const storeKeys = new Map([['a', { x: 1, y: 1 }], ['b', { x: 2, y: 2 }], ['c', { x: 3, y: 3 }]]);
    assert.equal(inheritOverlap(['a', 'b', 'c', 'd'], storeKeys), 0.75);
    assert.equal(inheritOverlap(['x', 'y'], storeKeys), 0);
    assert.equal(inheritOverlap(['a'], storeKeys), 1);
  });
});
