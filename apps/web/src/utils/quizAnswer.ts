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

/**
 * 锚是否属于「某张卡的某道题」（用于「作答」按钮的 .on 态与「再点当前题 =
 * 取消」判定）。
 *
 * 题目 id 只在围栏内唯一——「再来一套」的两张卡几乎必然撞 id（都是 q3）。
 * 仅凭 id 判定会让 A 卡的按钮把 B 卡的锚误判成「当前题」：点第二张卡变成
 * **取消**而不是换锚 → chip 无故消失 → 用户若没察觉直接发送，消息不带
 * 物化块 → 模型不批改、进度不涨，整条作答链路静默失效。
 *
 * 归属按「题号 + 卡片身份」认定：
 * - 题号：卡内唯一（1 起，与展示序号一致）；
 * - 卡片身份：指纹（内容派生、卡级）优先；指纹未就绪时退回内容比对
 *   （题干 + 评分点逐项一致）——与 backfillAnchorFingerprint 的归属规则同源。
 *
 * 已知边界：内容完全相同的两张卡指纹也相同 → 归属判定不可分（两卡互认
 * 对方的锚）。那种卡的物化消息本就等价，属可接受边界。
 */
export function anchorBelongsToQuestion(
  anchor: QuizAnswerAnchor | null | undefined,
  question: { stem: string; answer: string[] },
  cardFingerprintKey: string,
  questionIndex: number,
): boolean {
  if (!anchor) return false;
  if (anchor.questionIndex !== questionIndex) return false;
  if (anchor.fingerprintKey && cardFingerprintKey) {
    return anchor.fingerprintKey === cardFingerprintKey;
  }
  // 指纹未就绪（异步算出前）：退到内容判定（题干 + 评分点逐项一致）。
  return (
    anchor.stem === question.stem
    && anchor.points.length === question.answer.length
    && anchor.points.every((point, i) => point === question.answer[i])
  );
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
  // 题号也必须一致：撞 id 的两张卡里，题号是卡内定位的第二道闸
  // （id 只在围栏内唯一，题号 + 内容双重确认才认领这个锚）。题号口径与
  // 题卡渲染一致（questions 数组下标 + 1）。
  if (index + 1 !== current.anchor.questionIndex) return null;
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

// 判定枚举冻结三词（skill 1.5.0 批改回复格式）；「部分命中」「未命中」是同义
// 写法，宽容归并到 部分 / 未中。
const STATUS_WORDS: ReadonlyArray<readonly [string, QuizGradingPointStatus]> = [
  ['部分命中', 'partial'],
  ['未命中', 'miss'],
  ['命中', 'hit'],
  ['部分', 'partial'],
  ['未中', 'miss'],
];

// 标记行：题号 + 得分 X/Y。X 允许小数（模型按各评分点的完成度给部分分，
// 如 1.5/5），分隔符的空白/冒号/中文「分」/句末标点一并宽容——协议是模型
// 侧的约定，解析侧必须能容忍模型的排版自由，否则整块批改被静默丢弃
// （真机事故 2026-10-27：模型给了 1.5/5，旧正则只认整数，整块批改消失）。
const MARKER_RE =
  /^【批改·第(\d+)题】[ \t]*得分[ \t]*[:：]?[ \t]*(\d+(?:\.\d+)?)[ \t]*分?[ \t]*\/[ \t]*(\d+(?:\.\d+)?)[ \t]*分?[ \t]*[。.]?[ \t]*$/m;

// 逐点行：列表前缀（编号 1. / 1) / 1、 / 1． 或项目符号 - / * / •）
// + 判定词 + 分隔符（｜ / |）+ 依据。
const NUMBERED_POINT_RE = /^[ \t]*(\d+)[.、．)）][ \t]*(\S+?)[ \t]*[｜|][ \t]*(.*)$/;
const BULLET_POINT_RE = /^[ \t]*[-*•][ \t]*(\S+?)[ \t]*[｜|][ \t]*(.*)$/;

/** 从助手回复解析批改回写块；无标记/格式坏/total=0 → null（优雅降级，聊天批改兜底）。 */
export function parseGradingReply(text: string): QuizGrading | null {
  const marker = text.match(MARKER_RE);
  if (!marker) return null;
  const score = Number(marker[2]);
  const total = Number(marker[3]);
  if (total <= 0) return null;

  // 逐点行从标记行之后连续收集，遇首个不匹配行为止——之后的自由文本
  // （错因/讲解）照常留在聊天里，不进卡片。
  //
  // 两条防误收的判据（讲解段落里常有「- 命中｜…」这种形状的行）：
  // 1. 风格一致——首条逐点行定下风格（编号式 / 项目符号式），后续必须同风格；
  // 2. 编号式还须序号连续（1,2,3…）——讲解里另起的编号列表会被判为不连续而终止。
  // 空行本身不算终止（markdown 松散列表会在逐点行之间空行）。
  const afterMarker = text.slice(marker.index! + marker[0].length);
  const points: QuizGradingPoint[] = [];
  let style: 'numbered' | 'bullet' | null = null;
  let expectedNumber: number | null = null;
  for (const line of afterMarker.split('\n')) {
    if (line.trim() === '') continue;
    const numbered = line.match(NUMBERED_POINT_RE);
    const bullet = numbered ? null : line.match(BULLET_POINT_RE);
    if (!numbered && !bullet) break;
    if (style === null) style = numbered ? 'numbered' : 'bullet';
    if (numbered) {
      if (style !== 'numbered') break;
      const number = Number(numbered[1]);
      // 首行定基准（模型不必从 1 起编），其后须逐个递增——讲解里另起的
      // 编号列表因此会被判为不连续而终止收集。
      if (expectedNumber !== null && number !== expectedNumber) break;
      expectedNumber = number + 1;
    } else {
      if (style !== 'bullet') break;
    }
    const word = (numbered ? numbered[2] : bullet![1])!;
    const detail = (numbered ? numbered[3] : bullet![2])!;
    const status = STATUS_WORDS.find(([known]) => word === known);
    if (!status) break;
    points.push({ status: status[1], text: detail.trim() });
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

/**
 * 已作答的解答题（键 = `指纹:题号`）。
 *
 * 解答题的作答发生在聊天输入框里，不在题卡的本地 state——所以「已作答」
 * 只能像批改回写那样从消息序推导：扫到带【大题作答·第N题】标记且带
 * 「题目指纹」行的用户消息，即认为该卡该题已作答。
 *
 * 键与批改同构（指纹:题号）：两张同有第 3 题的卡各自独立，互不串。
 * 无指纹行的物化消息（v1 形态）无法归属到具体卡 → 不计入。
 */
export function pairSubjectAnswers(
  messages: ReadonlyArray<{ role: string; content: string }>,
): Set<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const meta = extractSubjectAnswerMeta(message.content);
    if (meta) answered.add(gradingMapKey(meta.key, meta.questionIndex));
  }
  return answered;
}
