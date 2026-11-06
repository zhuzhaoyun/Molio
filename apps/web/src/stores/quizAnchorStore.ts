/**
 * 大题作答锚（quiz 卡「作答」→ 问答输入框 chip）—— mirrors vaultStore /
 * messageSelectionStore 的 useSyncExternalStore 模式。
 *
 * 全局单值：点其他题的「作答」= 换锚；再点当前题 = 取消；发送成功后由
 * ChatComposer 清除。主页与悬浮面板两个 composer 共享同一锚（chip 会同时
 * 出现在两处，任一处发送都物化——一期接受的行为）。
 */
import { useSyncExternalStore } from 'react';
import type { QuizAnswerAnchor } from '../utils/quizAnswer';

type Listener = () => void;

export interface QuizAnchor {
  anchor: QuizAnswerAnchor;
  /** 锚来源题的 id：题卡按钮 .on 态与「再点当前题取消」的判定键。 */
  questionId: string;
}

let current: QuizAnchor | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const quizAnchorStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  get(): QuizAnchor | null {
    return current;
  },

  set(anchor: QuizAnswerAnchor, questionId: string) {
    current = { anchor, questionId };
    emit();
  },

  clear() {
    if (!current) return;
    current = null;
    emit();
  },

  /** 只清「本次发送消费掉的那个锚」：发送是异步的，await 期间用户可能
   *  已把锚换到别的题——无条件 clear 会把新锚误清掉（chip 无故消失）。 */
  clearIfCurrent(consumed: QuizAnchor | null) {
    if (!consumed || current !== consumed) return;
    current = null;
    emit();
  },
};

export function useQuizAnswerAnchor(): QuizAnchor | null {
  return useSyncExternalStore(quizAnchorStore.subscribe, quizAnchorStore.get, quizAnchorStore.get);
}
