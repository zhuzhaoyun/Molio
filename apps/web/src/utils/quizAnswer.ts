/**
 * 大题（subject）作答的消息物化与批改回写解析（M1：整卷一张表单）。
 *
 * 物化/批改的输出与解析格式是「唯一真源」：quiz skill 的批改协议按
 * 【大题作答·第N题】标记行确定性触发（不靠模型自觉），web 与 SKILL.md
 * 引用同一格式，任何一侧都不得单独演化。物化块自身以标记行开头；触发
 * 契约是「消息含标记行」而非「消息以标记开头」。评分点藏在围栏 answer
 * 字段，交卷前不离开题卡（草稿只在本地）。
 *
 * 物化 v2：出处行后带「题目指纹」行（quiz fingerprint 前 8 位）——批改
 * 回写题卡的关联键，对模型惰性（skill 注明批改时忽略）。触发标记行字节
 * 不变；指纹缺失时省略该行（退回 v1 形态，仅失去回写配对能力）。
 * 物化 v3：整卷一条消息（buildQuizSubmissionMessage），每题块与 v2 逐字节
 * 同形；解析侧（extractSubjectAnswers / parseGradingReplies）对 v2/v3 同样
 * 兼容——锚时代旧会话的消息序推导不受影响。
 */
import type { Quiz, QuizSelections } from './quiz';

/**
 * 单题物化块（v2 格式，v3 整卷消息的每题块复用同一构建器保证逐字节同形）。
 * 模块私有：v3 起对外只暴露 buildQuizSubmissionMessage。
 */
function buildSubjectAnswerMessage(
  anchor: {
    questionIndex: number;
    stem: string;
    points: string[];
    sources: string[];
    fingerprintKey: string;
  },
  userText: string,
): string {
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
// matchAll 要求 g 标志（同一正则源的全局变体；lastIndex 由 matchAll 自管）。
const MARKER_RE_G = new RegExp(MARKER_RE.source, MARKER_RE.flags + 'g');

// 逐点行：列表前缀（编号 1. / 1) / 1、 / 1． 或项目符号 - / * / •）
// + 判定词 + 分隔符（｜ / |）+ 依据。
const NUMBERED_POINT_RE = /^[ \t]*(\d+)[.、．)）][ \t]*(\S+?)[ \t]*[｜|][ \t]*(.*)$/;
const BULLET_POINT_RE = /^[ \t]*[-*•][ \t]*(\S+?)[ \t]*[｜|][ \t]*(.*)$/;

/** 从助手回复解析批改回写块；无标记/格式坏/total=0 → null（优雅降级，聊天批改兜底）。 */
export function parseGradingReply(text: string): QuizGrading | null {
  return parseGradingReplies(text)[0] ?? null;
}

/**
 * 从一条助手回复解析**全部**批改回写块（v3 整卷：skill 1.7.0 逐题连续输出
 * 多个批改块）。每个 marker 的逐点行收集到下一个 marker 行（或文末）为止，
 * 中间的讲解文本由逐点行的风格/连续判据自然终止，不会误收进任何块。
 * 只返回到达的块——模型漏批的题不补位、不编造。
 */
export function parseGradingReplies(text: string): QuizGrading[] {
  const markers = [...text.matchAll(MARKER_RE_G)];
  const gradings: QuizGrading[] = [];
  for (const [i, marker] of markers.entries()) {
    const score = Number(marker[2]);
    const total = Number(marker[3]);
    if (total <= 0) continue;
    const segmentEnd = i + 1 < markers.length ? markers[i + 1]!.index! : text.length;
    const segment = text.slice(marker.index! + marker[0].length, segmentEnd);
    gradings.push({
      questionIndex: Number(marker[1]),
      score,
      total,
      points: collectGradingPoints(segment),
    });
  }
  return gradings;
}

/**
 * 逐点行从标记行之后连续收集，遇首个不匹配行为止——之后的自由文本
 * （错因/讲解）照常留在聊天里，不进卡片。
 *
 * 两条防误收的判据（讲解段落里常有「- 命中｜…」这种形状的行）：
 * 1. 风格一致——首条逐点行定下风格（编号式 / 项目符号式），后续必须同风格；
 * 2. 编号式还须序号连续（1,2,3…）——讲解里另起的编号列表会被判为不连续而终止。
 * 空行本身不算终止（markdown 松散列表会在逐点行之间空行）。
 */
function collectGradingPoints(segment: string): QuizGradingPoint[] {
  const points: QuizGradingPoint[] = [];
  let style: 'numbered' | 'bullet' | null = null;
  let expectedNumber: number | null = null;
  for (const line of segment.split('\n')) {
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
  return points;
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
      // v3 整卷消息一条带多个作答块：每个题号的归属键都要登记。
      for (const answer of extractSubjectAnswers(message.content)) {
        lastAnswerByIndex.set(answer.questionIndex, answer.key);
      }
      continue;
    }
    if (message.role === 'assistant') {
      for (const grading of parseGradingReplies(message.content)) {
        const key = lastAnswerByIndex.get(grading.questionIndex);
        if (key) gradings.set(gradingMapKey(key, grading.questionIndex), grading);
      }
    }
  }
  return gradings;
}

/** 批改在 store/map 里的组合键：卡片按（自身指纹, 题号）取回。 */
export function gradingMapKey(fingerprintKey: string, questionIndex: number): string {
  return `${fingerprintKey}:${questionIndex}`;
}

/**
 * 已作答的解答题（键 = `指纹:题号`，值 = 作答正文）。
 *
 * 解答题的作答发生在聊天输入框里，不在题卡的本地 state——所以「已作答」
 * 只能像批改回写那样从消息序推导：扫到带【大题作答·第N题】标记且带
 * 「题目指纹」行的用户消息，即认为该卡该题已作答。
 *
 * 值留着正文：存为题库时「你的答案」要写原文（写不出来就只能写「见会话」）。
 * 同一键后写覆盖先写，与批改一样以最后一条为准。
 *
 * 键与批改同构（指纹:题号）：两张同有第 3 题的卡各自独立，互不串。
 * 无指纹行的物化消息（v1 形态）无法归属到具体卡 → 不计入。
 * 正文为空的锚同样不计入：那只说明用户点了「作答」又直接发送，没作答。
 */
export function pairSubjectAnswers(
  messages: ReadonlyArray<{ role: string; content: string }>,
): Map<string, string> {
  const answers = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const answer of extractSubjectAnswers(message.content)) {
      answers.set(gradingMapKey(answer.key, answer.questionIndex), answer.body);
    }
  }
  return answers;
}

// ── v3：整卷一条消息（M1）──────────────────────────────────────────────────

/** 整卷交卷消息里一道解答题的物化输入（由 QuizCard 从草稿态构建）。 */
export interface SubjectAnswerEntry {
  /** 围栏内题号（1 起），与题卡展示序号一致。 */
  questionIndex: number;
  stem: string;
  /** 评分点（围栏 answer 字段）。 */
  points: string[];
  /** 出处相对路径列表。 */
  sources: string[];
  /** quiz fingerprint 前 8 位（批改回写关联键）。 */
  fingerprintKey: string;
  /** 作答正文（卡内图片的 markdown 行已由调用方拼入）。 */
  body: string;
}

/**
 * 整卷交卷消息（v3）：首行是给人看的一句话（rail 预览/历史摘要/消息流三处
 * 同源受益——「导航面上可读」是消息格式的验收标准，不做 previewText 协议
 * 特判），其后每题一个作答块，块格式与 v2 buildSubjectAnswerMessage **逐字节
 * 同形**（复用同一构建器保证）——skill 的确定性触发、消息序配对、存为题库
 * 正文回写全部沿用。entries 为空返回 ''，调用方据此不发消息、不建 run
 * （纯客观卷/解答题全空的交卷只做本地判分）。
 */
export function buildQuizSubmissionMessage(
  quizTitle: string,
  entries: ReadonlyArray<SubjectAnswerEntry>,
): string {
  if (entries.length === 0) return '';
  const blocks = entries.map((entry) =>
    buildSubjectAnswerMessage(
      {
        questionIndex: entry.questionIndex,
        stem: entry.stem,
        points: entry.points,
        sources: entry.sources,
        fingerprintKey: entry.fingerprintKey,
      },
      entry.body,
    ),
  );
  return [`提交判卷：《${quizTitle}》`, '', blocks.join('\n\n')].join('\n');
}

/**
 * 把消息推导的作答正文拆回「文字 + 图片路径」（重做回填用）。
 *
 * 整行匹配图片 markdown（v3 的 `![作答图片](path)` 与锚时代 v2 的
 * `![image](path)` 都认）——只把「独占一行的图片」抽出来进可删除的缩略图，
 * 行内混排的图片语法保留在正文里照常渲染。文字行原序拼接、trim。
 */
export function splitSubjectBody(body: string): { text: string; images: string[] } {
  const textLines: string[] = [];
  const images: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^!\[[^\]]*\]\(([^)\s]+)\)\s*$/);
    if (m) images.push(m[1]!);
    else textLines.push(line);
  }
  return { text: textLines.join('\n').trim(), images };
}

/** 卡内作答图 → markdown 行（正文的一部分；渲染侧走 preprocessLocalImages）。 */
export function subjectImageMarkdown(paths: ReadonlyArray<string>): string {
  return paths.map((path) => `![作答图片](${path})`).join('\n');
}

/**
 * 从一条用户消息提取**全部**作答块（v3 整卷一条消息；v2 单题消息天然只有
 * 一块，解析兼容）。按【大题作答·第N题】标记行分块：每块取「题目指纹」行
 * 定位正文起点，正文 = 指纹行后到块尾（trim）。无指纹行的块（v1）跳过、
 * 正文为空的块跳过（点了作答又没写就发送的空锚）。
 */
export function extractSubjectAnswers(
  content: string,
): Array<{ questionIndex: number; key: string; body: string }> {
  const answers: Array<{ questionIndex: number; key: string; body: string }> = [];
  const lines = content.split('\n');
  let block: { questionIndex: number; startLine: number } | null = null;
  for (const [i, line] of lines.entries()) {
    const marker = line.match(/^【大题作答·第(\d+)题】\s*$/);
    if (marker) {
      if (block) pushAnswer(answers, lines, block.questionIndex, block.startLine, i);
      block = { questionIndex: Number(marker[1]), startLine: i };
    }
  }
  if (block) pushAnswer(answers, lines, block.questionIndex, block.startLine, lines.length);
  return answers;
}

function pushAnswer(
  answers: Array<{ questionIndex: number; key: string; body: string }>,
  lines: ReadonlyArray<string>,
  questionIndex: number,
  startLine: number,
  endLine: number,
): void {
  const segment = lines.slice(startLine + 1, endLine).join('\n');
  const fingerprint = segment.match(/^题目指纹：([0-9a-f]{8})\s*$/m);
  if (!fingerprint) return; // v1 块：无指纹行，无法归属到卡
  const after = segment.slice(fingerprint.index! + fingerprint[0].length);
  const body = after.replace(/^\r?\n\r?\n?/, '').trim();
  if (!body) return;
  answers.push({ questionIndex, key: fingerprint[1]!, body });
}

/**
 * 草稿 ∪ 消息推导的解答题正文合并（存为题库/回显共用数据源）。
 *
 * 草稿（本地 selections + subjectImages）转成 `指纹:题号` 键：文本 trim 后与
 * 图片 markdown 行用换行拼接（只有图也算作答——拍照作答不强迫打字）；derived
 * 有而无草稿的键保留（旧会话回显/存题库读消息正文）；同键草稿优先（正在
 * 编辑的草稿比历史消息新）。
 */
export function mergeSubjectDrafts(
  quiz: Quiz,
  selections: QuizSelections,
  subjectImages: Record<string, ReadonlyArray<string>>,
  derived: Map<string, string>,
  fingerprintKey: string,
): Map<string, string> {
  const merged = new Map(derived);
  for (const [index, question] of quiz.questions.entries()) {
    const images = subjectImages[question.id] ?? [];
    const imageMarkdown = subjectImageMarkdown(images);
    const text = (selections[question.id]?.[0] ?? '').trim();
    if (!text && !imageMarkdown) continue;
    const body = [text, imageMarkdown].filter(Boolean).join('\n');
    merged.set(gradingMapKey(fingerprintKey, index + 1), body);
  }
  return merged;
}
