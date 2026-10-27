/**
 * 批改回写 store：按会话缓存配对结果（ChatSessionView 写入，QuizCard 订阅）。
 * 纯逻辑测试（不含 React hook）：订阅通知 + 会话隔离 + 引用稳定。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const { quizGradingStore } = await import('../src/stores/quizGradingStore.ts');

const GRADING = {
  questionIndex: 4,
  score: 2,
  total: 3,
  points: [{ status: 'hit' as const, text: '对' }],
};

describe('quizGradingStore', () => {
  it('stores per conversation and reads back by key', () => {
    quizGradingStore.setConversation('conv-1', new Map([['aaaa1111', GRADING]]));
    assert.deepEqual(quizGradingStore.getQuizGrading('conv-1', 'aaaa1111'), GRADING);
    assert.equal(quizGradingStore.getQuizGrading('conv-2', 'aaaa1111'), null);
    assert.equal(quizGradingStore.getQuizGrading('conv-1', 'bbbb2222'), null);
    // 缺 conversationId（会话未落库）时安全返回 null。
    assert.equal(quizGradingStore.getQuizGrading(null, 'aaaa1111'), null);
    quizGradingStore.setConversation('conv-1', new Map());
    assert.equal(quizGradingStore.getQuizGrading('conv-1', 'aaaa1111'), null);
  });

  it('notifies subscribers only on writes', () => {
    let notified = 0;
    const unsubscribe = quizGradingStore.subscribe(() => { notified += 1; });
    // 用独立会话 id：模块单例跨用例共享，别的用例可能已把 conv-1 置为等值内容（短路不通知）。
    quizGradingStore.setConversation('conv-notify', new Map());
    assert.equal(notified, 1);
    unsubscribe();
    quizGradingStore.setConversation('conv-notify', new Map());
    assert.equal(notified, 1);
  });

  it('keeps the same object reference when the grading is unchanged', () => {
    const map = new Map([['aaaa1111', GRADING]]);
    quizGradingStore.setConversation('conv-1', map);
    const first = quizGradingStore.getQuizGrading('conv-1', 'aaaa1111');
    // 流式期间每个 delta 都会用新 Map 实例整体重算写入：内容未变时必须
    // 短路（不换引用、不通知），否则会话里每张题卡每个 delta 多渲染一次。
    const equalCopy = new Map([['aaaa1111', { ...GRADING, points: [{ ...GRADING.points[0]! }] }]]);
    let notified = 0;
    const unsubscribe = quizGradingStore.subscribe(() => { notified += 1; });
    quizGradingStore.setConversation('conv-1', equalCopy);
    assert.equal(notified, 0);
    assert.equal(quizGradingStore.getQuizGrading('conv-1', 'aaaa1111'), first);
    unsubscribe();
    // 内容真变了（分数更新）→ 正常写入并通知。
    const updated = new Map([['aaaa1111', { ...GRADING, score: 3 }]]);
    quizGradingStore.setConversation('conv-1', updated);
    assert.equal(quizGradingStore.getQuizGrading('conv-1', 'aaaa1111')?.score, 3);
  });
});
