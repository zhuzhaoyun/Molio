/**
 * 大题（subject）作答的锚数据与消息物化。
 *
 * buildSubjectAnswerMessage 的输出格式是唯一真源：quiz skill 的批改协议按
 * 【大题作答·第N题】标记行确定性触发（不靠模型自觉），web 与 SKILL.md 引用
 * 同一格式，任何一侧都不得单独演化。物化块自身以标记行开头；宿主可能再在
 * 消息最前面拼入附件/上下文前缀，所以触发契约是「消息含标记行」而非「消息
 * 以标记开头」。评分点藏在围栏 answer 字段，直到用户发送作答才随消息展开
 * （修「题卡直接可见答案」的剧透缺陷）。
 */

export interface QuizAnswerAnchor {
  /** 围栏内题号（1 起），与题卡展示序号一致。 */
  questionIndex: number;
  /** i18n 题型名（如「解答题」），仅用于 chip 展示。 */
  typeLabel: string;
  stem: string;
  /** 评分点（围栏 answer 字段）。 */
  points: string[];
  /** 出处相对路径列表。 */
  sources: string[];
}

export function subjectAnchorLabel(
  anchor: Pick<QuizAnswerAnchor, 'questionIndex' | 'typeLabel'>,
): string {
  return `第${anchor.questionIndex}题 · ${anchor.typeLabel}`;
}

export function buildSubjectAnswerMessage(anchor: QuizAnswerAnchor, userText: string): string {
  const lines = [
    `【大题作答·第${anchor.questionIndex}题】`,
    `题干：${anchor.stem}`,
    '评分点：',
    ...anchor.points.map((point, i) => `${i + 1}. ${point}`),
    `出处：${anchor.sources.join('；')}`,
  ];
  return `${lines.join('\n')}\n\n${userText}`;
}
