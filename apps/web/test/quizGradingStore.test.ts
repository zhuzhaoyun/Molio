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
    quizGradingStore.setConversation('conv-1', new Map());
    assert.equal(notified, 1);
    unsubscribe();
    quizGradingStore.setConversation('conv-1', new Map());
    assert.equal(notified, 1);
  });

  it('keeps the same object reference when the grading is unchanged', () => {
    const map = new Map([['aaaa1111', GRADING]]);
    quizGradingStore.setConversation('conv-1', map);
    const first = quizGradingStore.getQuizGrading('conv-1', 'aaaa1111');
    // 同一个 Map 实例重复写入（流式期间 messages 数组 identity 变化但配对结果
    // 未变）→ 读取引用稳定，useSyncExternalStore 不触发多余渲染。
    quizGradingStore.setConversation('conv-1', map);
    assert.equal(quizGradingStore.getQuizGrading('conv-1', 'aaaa1111'), first);
  });
});
