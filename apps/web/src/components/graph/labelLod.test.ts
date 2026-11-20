import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectLabels, type LabelLodNode } from './labelLod.ts';

/**
 * 统一标签 LOD 规则的行为约定测试（设计 docs/2026-11-18-graph-h2-expand-interaction-design.md §4.3 + 代拍 B/C）：
 * 候选=视口内；eligible=forceShow || hovered || 屏幕直径≥8px；排序 hovered > neighbour > forceShow > 度数；
 * 截 maxOnScreen=60。hovered 无条件显（拍板 #2），neighbour 只享 cap 内优先权不豁免直径门（治标签汤）。
 */

/** 大视口（0,0 起，1000×1000）——默认所有节点都在屏内 */
const FULL_VIEW = { x: 0, y: 0, w: 1000, h: 1000 };

function n(key: string, opts: Partial<LabelLodNode> & { radius: number }): LabelLodNode {
  return { key, x: 500, y: 500, degree: 1, ...opts };
}

describe('视口过滤', () => {
  it('视口外节点不入选（中心在 rect 外即排除）', () => {
    const out = n('out', { radius: 50, x: -100, y: 500 });
    const inView = n('in', { radius: 50, x: 500, y: 500 });
    const shown = selectLabels({ nodes: [out, inView], view: FULL_VIEW, k: 1, hoveredKey: null, neighbourKeys: new Set() });
    assert.ok(shown.includes('in'));
    assert.ok(!shown.includes('out'));
  });

  it('贴边节点：中心恰在 rect 边界上仍入选（pad 含 radius）', () => {
    // 中心 (5, 500)、radius=10：严格 rect 会排除，规则用 radius pad → 入选
    const edge = n('edge', { radius: 10, x: 5, y: 500 });
    const shown = selectLabels({ nodes: [edge], view: FULL_VIEW, k: 1, hoveredKey: null, neighbourKeys: new Set() });
    assert.deepEqual(shown, ['edge']);
  });
});

describe('屏幕直径阈值（代拍 B/C：8px，不绑绝对 zoom）', () => {
  it('直径 < 8px 不入选', () => {
    const node = n('small', { radius: 5 }); // 2*5*0.7 = 7 < 8
    const shown = selectLabels({ nodes: [node], view: FULL_VIEW, k: 0.7, hoveredKey: null, neighbourKeys: new Set() });
    assert.deepEqual(shown, []);
  });

  it('直径 ≥ 8px 入选', () => {
    const node = n('big', { radius: 5 }); // 2*5*0.9 = 9 ≥ 8
    const shown = selectLabels({ nodes: [node], view: FULL_VIEW, k: 0.9, hoveredKey: null, neighbourKeys: new Set() });
    assert.deepEqual(shown, ['big']);
  });

  it('同 radius 不同 k：阈值判的是屏幕直径而非 zoom 值', () => {
    const node = n('n', { radius: 20 }); // k=0.1 → 4px 不显；k=0.25 → 10px 显
    assert.deepEqual(
      selectLabels({ nodes: [node], view: FULL_VIEW, k: 0.1, hoveredKey: null, neighbourKeys: new Set() }),
      [],
    );
    assert.deepEqual(
      selectLabels({ nodes: [node], view: FULL_VIEW, k: 0.25, hoveredKey: null, neighbourKeys: new Set() }),
      ['n'],
    );
  });
});

describe('hovered / neighbour / forceShow', () => {
  it('hovered 无条件显（远低于直径阈也显）且排首位', () => {
    const hovered = n('hov', { radius: 1, degree: 0 });
    const normal = n('norm', { radius: 50, degree: 9 });
    const shown = selectLabels({ nodes: [normal, hovered], view: FULL_VIEW, k: 0.1, hoveredKey: 'hov', neighbourKeys: new Set() });
    assert.equal(shown[0], 'hov');
    assert.ok(shown.includes('norm'));
    assert.equal(shown.length, 2);
  });

  it('neighbour 过阈才显（镜头远时高亮但不显名——拍板 #2）', () => {
    const neighbour = n('nb', { radius: 2 }); // 2*2*0.5=2 < 8
    const shown = selectLabels({ nodes: [neighbour], view: FULL_VIEW, k: 0.5, hoveredKey: 'hov', neighbourKeys: new Set(['nb']) });
    assert.deepEqual(shown, []);
  });

  it('neighbour 在 cap 内享优先：排普通高度数节点之前', () => {
    const nodes: LabelLodNode[] = [
      n('nb1', { radius: 50, degree: 1 }),
      n('nb2', { radius: 50, degree: 1 }),
      ...Array.from({ length: 50 }, (_, i) => n(`deg${i}`, { radius: 50, degree: 100 - i })),
    ];
    const neighbourKeys = new Set(['nb1', 'nb2']);
    const shown = selectLabels({ nodes, view: FULL_VIEW, k: 1, hoveredKey: null, neighbourKeys, maxOnScreen: 10 });
    assert.equal(shown.length, 10);
    assert.deepEqual(shown.slice(0, 2), ['nb1', 'nb2']); // 邻居优先
    assert.deepEqual(shown.slice(2), ['deg0', 'deg1', 'deg2', 'deg3', 'deg4', 'deg5', 'deg6', 'deg7']); // 余位按度数
  });

  it('blob forceShow 过阈豁免（trunk 远景 blob 名不消失——T2 行为不变）', () => {
    const blob = n('c1', { radius: 6.2, forceShow: true }); // 直径 1.24px @k=0.1，远低于阈
    const shown = selectLabels({ nodes: [blob], view: FULL_VIEW, k: 0.1, hoveredKey: null, neighbourKeys: new Set() });
    assert.deepEqual(shown, ['c1']);
  });
});

describe('同屏上限（防汤）', () => {
  it('无 hover：纯 LOD + 度数降序截 60', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => n(`k${String(i).padStart(2, '0')}`, { radius: 50, degree: 100 - i }));
    const shown = selectLabels({ nodes, view: FULL_VIEW, k: 1, hoveredKey: null, neighbourKeys: new Set() });
    assert.equal(shown.length, 60);
    assert.equal(shown[0], 'k00'); // 度数最高
    assert.equal(shown[59], 'k59');
  });

  it('上限计入 hovered 与 neighbour（它们享优先不豁免截断总量）', () => {
    const nodes: LabelLodNode[] = [
      n('hov', { radius: 1, degree: 0 }),
      ...Array.from({ length: 70 }, (_, i) => n(`m${String(i).padStart(2, '0')}`, { radius: 50, degree: 50 - i })),
    ];
    const shown = selectLabels({ nodes, view: FULL_VIEW, k: 1, hoveredKey: 'hov', neighbourKeys: new Set(['m00', 'm01']) });
    assert.equal(shown.length, 60);
    assert.deepEqual(shown.slice(0, 3), ['hov', 'm00', 'm01']);
  });

  it('同优先级按 key 字典序稳定排序', () => {
    const a = n('b', { radius: 50, degree: 5 });
    const b = n('a', { radius: 50, degree: 5 });
    const shown = selectLabels({ nodes: [a, b], view: FULL_VIEW, k: 1, hoveredKey: null, neighbourKeys: new Set() });
    assert.deepEqual(shown, ['a', 'b']);
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(selectLabels({ nodes: [], view: FULL_VIEW, k: 1, hoveredKey: null, neighbourKeys: new Set() }), []);
  });
});
