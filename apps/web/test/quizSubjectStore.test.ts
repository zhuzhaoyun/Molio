/**
 * 解答题状态 store：按会话缓存「已作答 + 批改」两份状态（ChatSessionView 写入，
 * QuizCard 订阅）。纯逻辑测试（不含 React hook）：订阅通知 + 会话隔离 + 引用稳定。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const { quizSubjectStore } = await import('../src/stores/quizSubjectStore.ts');

const GRADING = {
  questionIndex: 4,
  score: 2,
  total: 3,
  points: [{ status: 'hit' as const, text: '对' }],
};

describe('quizSubjectStore', () => {
  it('stores per conversation and reads back by key', () => {
    quizSubjectStore.setConversation('conv-1', new Map([['aaaa1111:4', GRADING]]), new Set());
    const state = quizSubjectStore.getQuizSubjectState('conv-1');
    assert.deepEqual(state?.gradings.get('aaaa1111:4'), GRADING);
    assert.equal(state?.answered.has('aaaa1111:4'), false);
    // 会话隔离：另一个会话看不到。
    assert.equal(quizSubjectStore.getQuizSubjectState('conv-2'), null);
    assert.equal(quizSubjectStore.getQuizSubjectState(null), null);
  });

  it('records the answered set alongside the gradings', () => {
    quizSubjectStore.setConversation(
      'conv-answered',
      new Map(),
      new Set(['aaaa1111:4']),
    );
    const state = quizSubjectStore.getQuizSubjectState('conv-answered');
    assert.equal(state?.answered.has('aaaa1111:4'), true);
    assert.equal(state?.answered.has('bbbb2222:4'), false);
  });

  it('notifies subscribers only on writes', () => {
    let notified = 0;
    const unsubscribe = quizSubjectStore.subscribe(() => { notified += 1; });
    // 用独立会话 id：模块单例跨用例共享，别的用例可能已把该会话置为等值内容（短路不通知）。
    quizSubjectStore.setConversation('conv-notify', new Map(), new Set());
    assert.equal(notified, 1);
    unsubscribe();
    quizSubjectStore.setConversation('conv-notify', new Map(), new Set());
    assert.equal(notified, 1);
  });

  it('keeps the same object reference when nothing changed', () => {
    const map = new Map([['aaaa1111:4', GRADING]]);
    quizSubjectStore.setConversation('conv-1', map, new Set(['aaaa1111:4']));
    const first = quizSubjectStore.getQuizSubjectState('conv-1');
    // 流式期间每个 delta 都会用新 Map/Set 实例整体重算写入：内容未变时必须
    // 短路（不换引用、不通知），否则会话里每张题卡每个 delta 多渲染一次。
    const equalMap = new Map([['aaaa1111:4', { ...GRADING, points: [{ ...GRADING.points[0]! }] }]]);
    const equalSet = new Set(['aaaa1111:4']);
    let notified = 0;
    const unsubscribe = quizSubjectStore.subscribe(() => { notified += 1; });
    quizSubjectStore.setConversation('conv-1', equalMap, equalSet);
    assert.equal(notified, 0);
    assert.equal(quizSubjectStore.getQuizSubjectState('conv-1'), first);
    unsubscribe();
    // 内容真变了（分数更新）→ 正常写入并通知。
    quizSubjectStore.setConversation(
      'conv-1',
      new Map([['aaaa1111:4', { ...GRADING, score: 3 }]]),
      equalSet,
    );
    assert.equal(quizSubjectStore.getQuizSubjectState('conv-1')?.gradings.get('aaaa1111:4')?.score, 3);
  });
});
