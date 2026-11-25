import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planSeedRefine } from './seedPolicy.ts';
import { DEFAULT_FORCE_PARAMS } from './types.ts';
import { REFINE_ALPHA_FULL, REFINE_ALPHA_PARTIAL, REFINE_ALPHA_DECAY, REFINE_COVERAGE } from '@molio/contracts';

/**
 * H3 Task 5：浏览器侧播种精修档（设计 §3.3 + builder check 裁定 4）。
 *
 * 三档：全量种子+默认配方+nodeScale=1 → 低温快衰减；部分种子 → 中温；
 * 无种子/改过力参/nodeScale≠1 → 现状（α=1 默认衰减）。
 */

const base = { forces: { ...DEFAULT_FORCE_PARAMS }, nodeScale: 1 };

describe('planSeedRefine 三档', () => {
  it('覆盖率达标 + 默认力参 + nodeScale=1 → 全量精修档 α=0.1/decay=0.06', () => {
    const r = planSeedRefine({ seedCount: 80, nodeCount: 100, ...base });
    assert.equal(r.alpha, REFINE_ALPHA_FULL);
    assert.equal(r.alphaDecay, REFINE_ALPHA_DECAY);
  });

  it('边界：覆盖率恰为 0.8 走全量档；0.79 降为部分档', () => {
    assert.equal(planSeedRefine({ seedCount: 80, nodeCount: 100, ...base }).alpha, REFINE_ALPHA_FULL);
    assert.equal(planSeedRefine({ seedCount: 79, nodeCount: 100, ...base }).alpha, REFINE_ALPHA_PARTIAL);
    assert.equal(planSeedRefine({ seedCount: 79, nodeCount: 100, ...base }).alphaDecay, REFINE_ALPHA_DECAY);
  });

  it('部分种子（覆盖率不足但有种子）→ α=0.3/decay=0.06', () => {
    const r = planSeedRefine({ seedCount: 10, nodeCount: 100, ...base });
    assert.equal(r.alpha, REFINE_ALPHA_PARTIAL);
    assert.equal(r.alphaDecay, REFINE_ALPHA_DECAY);
  });

  it('无种子 → 现状档 α=1/默认衰减 0.0228', () => {
    const r = planSeedRefine({ seedCount: 0, nodeCount: 100, ...base });
    assert.equal(r.alpha, 1);
    assert.equal(r.alphaDecay, 0.0228);
  });

  it('改过任一力参 → 回退现状档（种子只当初值）', () => {
    for (const patch of [
      { repelStrength: -50 },
      { centerStrength: 0.3 },
      { linkDistance: 30 },
      { linkStrength: 0.5 },
    ] as const) {
      const r = planSeedRefine({ seedCount: 100, nodeCount: 100, forces: { ...DEFAULT_FORCE_PARAMS, ...patch }, nodeScale: 1 });
      assert.equal(r.alpha, 1, JSON.stringify(patch));
      assert.equal(r.alphaDecay, 0.0228);
    }
  });

  it('nodeScale≠1 → 回退现状档（collide 全局失配，低温精修会卡住）', () => {
    for (const nodeScale of [0.5, 2]) {
      const r = planSeedRefine({ seedCount: 100, nodeCount: 100, forces: { ...DEFAULT_FORCE_PARAMS }, nodeScale });
      assert.equal(r.alpha, 1, `nodeScale=${nodeScale}`);
    }
  });

  it('REFINE_COVERAGE 引用一致（0.8）', () => {
    assert.equal(REFINE_COVERAGE, 0.8);
  });
});
