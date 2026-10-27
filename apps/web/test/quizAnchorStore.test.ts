/**
 * 大题作答锚 store 的纯逻辑（无 React 渲染）。
 * 重点：clearIfCurrent 只清「本次发送消费掉的那个锚」——发送是异步的，
 * await 期间用户可能已经把锚换到另一道题，无条件 clear 会把新锚误清掉。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const { quizAnchorStore } = await import('../src/stores/quizAnchorStore.ts');

const ANCHOR_A = {
  questionIndex: 3,
  typeLabel: '解答题',
  stem: '题 A',
  points: ['评分点'],
  sources: ['wiki/a.md'],
};

describe('quizAnchorStore', () => {
  it('set / get / clear the single anchor', () => {
    quizAnchorStore.clear();
    assert.equal(quizAnchorStore.get(), null);
    quizAnchorStore.set(ANCHOR_A, 'q3');
    const current = quizAnchorStore.get();
    assert.equal(current?.questionId, 'q3');
    assert.equal(current?.anchor.stem, '题 A');
    quizAnchorStore.clear();
    assert.equal(quizAnchorStore.get(), null);
  });

  it('clearIfCurrent only clears the consumed anchor, not a newer one', () => {
    quizAnchorStore.clear();
    quizAnchorStore.set(ANCHOR_A, 'q3');
    const consumed = quizAnchorStore.get();

    // 发送 await 期间用户换锚到另一题。
    quizAnchorStore.set({ ...ANCHOR_A, stem: '题 B' }, 'q5');
    quizAnchorStore.clearIfCurrent(consumed);
    assert.equal(quizAnchorStore.get()?.questionId, 'q5');

    // 消费的就是当前锚 → 清掉。
    quizAnchorStore.clearIfCurrent(quizAnchorStore.get());
    assert.equal(quizAnchorStore.get(), null);

    // 空锚时 clearIfCurrent 是安全 no-op。
    quizAnchorStore.clearIfCurrent(null);
    assert.equal(quizAnchorStore.get(), null);
  });
});
