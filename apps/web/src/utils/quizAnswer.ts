/**
 * 大题（subject）作答的锚数据、消息物化与批改回写解析。
 *
 * 物化/批改的输出与解析格式是「唯一真源」：quiz skill 的批改协议按
 * 【大题作答·第N题】标记行确定性触发（不靠模型自觉），web 与 SKILL.md
 * 引用同一格式，任何一侧都不得单独演化。物化块自身以标记行开头；宿主
 * 可能再在消息最前面拼入附件/上下文前缀，所以触发契约是「消息含标记行」
 * 而非「消息以标记开头」。评分点藏在围栏 answer 字段，直到用户发送作答
 * 才随消息展开（修「题卡直接可见答案」的剧透缺陷）。
 *
 * 物化 v2：出处行后带「题目指纹」行（quiz fingerprint 前 8 位）——批改
 * 回写题卡的关联键，对模型惰性（skill 注明批改时忽略）。触发标记行字节
 * 不变；指纹缺失时省略该行（退回 v1 形态，仅失去回写配对能力）。
 */
import type { Quiz } from './quiz';

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
  /** quiz fingerprint 前 8 位（题卡算出后随锚携带）；'' = 指纹未就绪。 */
  fingerprintKey: string;
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
  if (anchor.fingerprintKey) lines.push(`题目指纹：${anchor.fingerprintKey}`);
  return `${lines.join('\n')}\n\n${userText}`;
}

/**
 * 指纹晚于点击就绪时，把挂着的锚补上 key。归属认定必须用内容（题干 +
 * 评分点逐项一致）而非题目 id——id 只在围栏内唯一，「再来一套」的两张卡
 * 几乎必然撞 id，仅凭 id 会让 A 卡的补齐 effect 覆写 B 卡挂的锚（互写
 * 成环）。且只碰 key 为空的锚：非空 key 恒为正确值（挂锚时的回调或本卡
 * 的补齐写入），绝不动。不属于本卡的锚返回 null。
 */
export function backfillAnchorFingerprint(
  quiz: import('./quiz').Quiz,
  fingerprint: string,
  current: { anchor: QuizAnswerAnchor; questionId: string },
): QuizAnswerAnchor | null {
  const key = fingerprint.slice(0, 8);
  if (current.anchor.fingerprintKey === key) return null;
  if (current.anchor.fingerprintKey !== '') return null;
  const index = quiz.questions.findIndex((q) => q.id === current.questionId);
  if (index < 0) return null;
  const question = quiz.questions[index]!;
  if (question.type !== 'subject') return null;
  if (question.stem !== current.anchor.stem) return null;
  if (
    question.answer.length !== current.anchor.points.length
    || question.answer.some((point, i) => point !== current.anchor.points[i])
  ) {
    return null;
  }
  return { ...current.anchor, fingerprintKey: key };
}

/** 从用户物化消息里取 题号 + 指纹（v1 消息无指纹行 → null）。 */
export function extractSubjectAnswerMeta(
  text: string,
): { questionIndex: number; key: string } | null {
  const marker = text.match(/^【大题作答·第(\d+)题】/m);
  if (!marker) return null;
  const key = text.match(/^题目指纹：([0-9a-f]{8})$/m);
  if (!key) return null;
  return { questionIndex: Number(marker[1]), key: key[1]! };
}

export type QuizGradingPointStatus = 'hit' | 'partial' | 'miss';

export interface QuizGradingPoint {
  status: QuizGradingPointStatus;
  /** 依据（skill 冻结格式：一句话、自足成句）。 */
  text: string;
}

export interface QuizGrading {
  questionIndex: number;
  score: number;
  total: number;
  points: QuizGradingPoint[];
}

// 判定枚举冻结三词（skill 1.4.0 批改回复格式）；「部分命中」宽容归并到 部分。
const STATUS_WORDS: ReadonlyArray<readonly [string, QuizGradingPointStatus]> = [
  ['部分命中', 'partial'],
  ['命中', 'hit'],
  ['部分', 'partial'],
  ['未中', 'miss'],
];

/** 从助手回复解析批改回写块；无标记/格式坏/total=0 → null（优雅降级，聊天批改兜底）。 */
export function parseGradingReply(text: string): QuizGrading | null {
  const marker = text.match(/^【批改·第(\d+)题】得分\s+(\d+)\/(\d+)\s*$/m);
  if (!marker) return null;
  const score = Number(marker[2]);
  const total = Number(marker[3]);
  if (total <= 0) return null;

  // 逐点行从标记行之后连续收集，遇首个不匹配行为止——之后的自由文本
  // （错因/讲解）照常留在聊天里，不进卡片。
  const afterMarker = text.slice(text.indexOf(marker[0]) + marker[0].length);
  const points: QuizGradingPoint[] = [];
  for (const line of afterMarker.split('\n')) {
    const point = line.match(/^\s*\d+\.\s*(\S+?)｜(.*)$/);
    if (!point) {
      if (line.trim() === '' && points.length === 0) continue;
      break;
    }
    const status = STATUS_WORDS.find(([word]) => point[1] === word);
    if (!status) break;
    points.push({ status: status[1], text: point[2]!.trim() });
  }

  return { questionIndex: Number(marker[1]), score, total, points };
}

/**
 * 按会话消息序把批改配对到题卡：每个题号 N 记住最近一次物化作答的指纹，
 * 遇到批改标记就归属该指纹（多卡同题号不串；同卡重答后到覆盖；
 * 无作答在前的批改丢弃）。map 键 = `指纹:题号`——一张卡可以有多道
 * 解答题，指纹相同，必须按题号再分。
 */
export function pairQuizGradings(
  messages: ReadonlyArray<{ role: string; content: string }>,
): Map<string, QuizGrading> {
  const lastAnswerByIndex = new Map<number, string>();
  const gradings = new Map<string, QuizGrading>();
  for (const message of messages) {
    if (message.role === 'user') {
      const meta = extractSubjectAnswerMeta(message.content);
      if (meta) lastAnswerByIndex.set(meta.questionIndex, meta.key);
      continue;
    }
    if (message.role === 'assistant') {
      const grading = parseGradingReply(message.content);
      if (!grading) continue;
      const key = lastAnswerByIndex.get(grading.questionIndex);
      if (key) gradings.set(gradingMapKey(key, grading.questionIndex), grading);
    }
  }
  return gradings;
}

/** 批改在 store/map 里的组合键：卡片按（自身指纹, 题号）取回。 */
export function gradingMapKey(fingerprintKey: string, questionIndex: number): string {
  return `${fingerprintKey}:${questionIndex}`;
}
