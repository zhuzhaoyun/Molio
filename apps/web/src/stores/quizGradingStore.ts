/**
 * 批改回写 store——ChatSessionView 写入（pairQuizGradings 的会话级结果），
 * QuizCard 订阅（useQuizGrading(conversationId, key8)）。
 *
 * mirrors vaultStore / quizAnchorStore 的 useSyncExternalStore 模式。数据
 * 全部从会话消息推导（pairQuizGradings 纯函数），无持久状态：历史刷新后
 * 重算即可回写。getSnapshot 按组合键取值，配对结果未变时引用稳定。
 */
import { useSyncExternalStore } from 'react';
import type { QuizGrading } from '../utils/quizAnswer';

type Listener = () => void;

const byConversation = new Map<string, Map<string, QuizGrading>>();
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function sameGradings(a: Map<string, QuizGrading>, b: Map<string, QuizGrading>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, grading] of a) {
    const other = b.get(key);
    if (!other) return false;
    if (
      grading.questionIndex !== other.questionIndex
      || grading.score !== other.score
      || grading.total !== other.total
      || grading.points.length !== other.points.length
    ) {
      return false;
    }
    for (let i = 0; i < grading.points.length; i++) {
      const p = grading.points[i]!;
      const q = other.points[i]!;
      if (p.status !== q.status || p.text !== q.text) return false;
    }
  }
  return true;
}

export const quizGradingStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  /** ChatSessionView 的 effect 在 messages 变化（含流式每个 delta）时整体
   *  重算写入。内容未变时短路：不换引用、不通知——否则会话里每张题卡
   *  每个 delta 都要多渲染一次。 */
  setConversation(conversationId: string, gradings: Map<string, QuizGrading>) {
    const existing = byConversation.get(conversationId);
    if (existing && sameGradings(existing, gradings)) return;
    byConversation.set(conversationId, gradings);
    emit();
  },

  getQuizGrading(conversationId: string | null | undefined, key: string): QuizGrading | null {
    if (!conversationId || !key) return null;
    return byConversation.get(conversationId)?.get(key) ?? null;
  },
};

/**
 * QuizCard 用：整张配对表（卡内可能有多道解答题，按 `指纹:题号` 组合键
 * 取各自的批改）。hook 必须在组件顶层调用（不能在题目循环里），所以给
 * 整会话一张表、读取用普通函数 getQuizGrading。
 */
export function useQuizGradings(
  conversationId: string | null | undefined,
): Map<string, QuizGrading> | null {
  return useSyncExternalStore(
    quizGradingStore.subscribe,
    () => (conversationId ? byConversation.get(conversationId) ?? null : null),
    () => (conversationId ? byConversation.get(conversationId) ?? null : null),
  );
}
