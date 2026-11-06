/**
 * 解答题状态 store——ChatSessionView 写入（从会话消息推导），QuizCard 订阅。
 *
 * 存三类状态，键同构（`指纹:题号`）：
 * - answers：这道解答题的作答正文（作答发生在聊天输入框里 → 只能从消息序推导，
 *   跨刷新可恢复，比题卡本地 state 更可靠；正文给「存为题库」回写用）
 * - answered：由 answers 的键派生（保留给只关心「答没答」的 UI）
 * - gradings：这道解答题的批改结果（模型批改回复 → 同样从消息序推导）
 *
 * mirrors vaultStore / quizAnchorStore 的 useSyncExternalStore 模式。无持久
 * 状态：历史刷新后重算即可。内容未变时短路（不换引用、不通知）——否则会话
 * 里每张题卡每个流式 delta 都要多渲染一次。
 */
import { useSyncExternalStore } from 'react';
import type { QuizGrading } from '../utils/quizAnswer';

type Listener = () => void;

export interface QuizSubjectState {
  /** 批改结果：键 = `指纹:题号` */
  gradings: Map<string, QuizGrading>;
  /** 作答正文：键 = `指纹:题号` */
  answers: Map<string, string>;
  /** 已作答的解答题（= answers 的键）：键 = `指纹:题号` */
  answered: Set<string>;
}

const byConversation = new Map<string, QuizSubjectState>();
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

function sameAnswers(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, body] of a) {
    if (b.get(key) !== body) return false;
  }
  return true;
}

export const quizSubjectStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  /** ChatSessionView 的 effect 在 messages 变化（含流式每个 delta）时整体
   *  重算写入。两份内容都没变时短路：不换引用、不通知。 */
  setConversation(
    conversationId: string,
    gradings: Map<string, QuizGrading>,
    answers: Map<string, string>,
  ) {
    const existing = byConversation.get(conversationId);
    if (
      existing
      && sameGradings(existing.gradings, gradings)
      && sameAnswers(existing.answers, answers)
    ) {
      return;
    }
    byConversation.set(conversationId, {
      gradings,
      answers,
      answered: new Set(answers.keys()),
    });
    emit();
  },

  getQuizSubjectState(conversationId: string | null | undefined): QuizSubjectState | null {
    if (!conversationId) return null;
    return byConversation.get(conversationId) ?? null;
  },
};

/**
 * QuizCard 用：整会话一张表、读取用普通函数。hook 必须在组件顶层调用
 * （不能在题目循环里），所以给整会话一张表。
 */
export function useQuizSubjects(
  conversationId: string | null | undefined,
): QuizSubjectState | null {
  return useSyncExternalStore(
    quizSubjectStore.subscribe,
    () => (conversationId ? byConversation.get(conversationId) ?? null : null),
    () => (conversationId ? byConversation.get(conversationId) ?? null : null),
  );
}
