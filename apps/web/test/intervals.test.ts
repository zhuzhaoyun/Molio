/**
 * 一维区间集合运算 —— rule-sandbox 判定排序的基础。
 *
 * 判定条件都是「可拖参数 OP 常量」，因此每条判定对应参数轴上的一个区间。
 * 区间只用于**比较判定的具体程度**（谁更窄谁更权威），命中判定本身仍由
 * 原始条件精确求值，避免严格不等号的边界被近似吃掉。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const {
  normalize, contains, intersect, union, isSubsetOf, measure,
} = await import('../src/utils/intervals.ts');

describe('intervals', () => {
  it('normalizes overlapping and adjacent intervals', () => {
    assert.deepEqual(
      normalize([{ lo: 0, hi: 10 }, { lo: 5, hi: 20 }, { lo: 30, hi: 40 }]),
      [{ lo: 0, hi: 20 }, { lo: 30, hi: 40 }],
    );
  });

  it('contains checks membership', () => {
    const set = normalize([{ lo: 0, hi: 10 }]);
    assert.equal(contains(set, 0), true);
    assert.equal(contains(set, 10), true);
    assert.equal(contains(set, 11), false);
    assert.equal(contains(set, -1), false);
  });

  it('intersect keeps the overlap', () => {
    assert.deepEqual(
      intersect([{ lo: 0, hi: 10 }], [{ lo: 5, hi: 20 }]),
      [{ lo: 5, hi: 10 }],
    );
    assert.deepEqual(
      intersect([{ lo: 0, hi: 4 }], [{ lo: 5, hi: 20 }]),
      [],
    );
  });

  it('union merges overlapping parts', () => {
    assert.deepEqual(
      union([{ lo: 0, hi: 10 }], [{ lo: 5, hi: 20 }]),
      [{ lo: 0, hi: 20 }],
    );
    assert.deepEqual(
      union([{ lo: 0, hi: 4 }], [{ lo: 5, hi: 20 }]),
      [{ lo: 0, hi: 4 }, { lo: 5, hi: 20 }],
    );
  });

  it('isSubsetOf detects a narrower region', () => {
    const wide = [{ lo: 0, hi: 100 }];
    const narrow = [{ lo: 60, hi: 100 }];
    const disjoint = [{ lo: 200, hi: 300 }];
    assert.equal(isSubsetOf(narrow, wide), true);
    assert.equal(isSubsetOf(wide, narrow), false);
    assert.equal(isSubsetOf(disjoint, wide), false);
  });

  it('measure sums lengths and reports Infinity for unbounded regions', () => {
    assert.equal(measure([{ lo: 0, hi: 10 }, { lo: 20, hi: 30 }]), 20);
    assert.equal(measure([{ lo: 0, hi: Infinity }]), Infinity);
  });
});
