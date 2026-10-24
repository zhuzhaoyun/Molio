/**
 * Quiz 交互块协议（```quiz 围栏 JSON）的纯函数层。
 *
 * 这里不碰 DOM / 网络 / React：解析、判分、指纹、localStorage 形状、
 * 流式剥离都可以直接在 node:test 里跑。渲染在 components/QuizCard.tsx。
 */

export const QUIZ_PROTOCOL_VERSION = 1;
export const MAX_QUIZ_RAW_CHARS = 512_000;
export const MAX_QUIZ_QUESTIONS = 100;
export const MAX_QUIZ_OPTIONS = 8;
/** fill 可接受写法个数上限（第 1 个是标准答案，其余为同义写法）。 */
export const MAX_FILL_ANSWERS = 8;
/** 与 daemon /api/quiz/attempts 的上限保持一致：渲染放行、落库拒绝 = 答题记录静默丢失。
 *  同时约束 fill：答案写法每项 ≤64，用户输入框 maxLength 也用它。 */
export const MAX_QUIZ_KEY_CHARS = 64;
export const MAX_QUIZ_ID_CHARS = 200;

export type QuizQuestionType = 'single' | 'multiple' | 'judge' | 'fill';

export interface QuizOption {
  key: string;
  text: string;
}

export interface QuizSource {
  path: string;
  quote?: string;
}

export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  stem: string;
  options: QuizOption[];
  answer: string[];
  explanation: string;
  sources: QuizSource[];
}

export interface Quiz {
  version: 1;
  title: string;
  questions: QuizQuestion[];
}

export interface InvalidQuestion {
  index: number;
  reason: string;
  /** 原始题目对象，用于展示「原题 + 该题格式有误」。 */
  raw: unknown;
}

export type QuizParseResult =
  | { ok: true; quiz: Quiz; invalidQuestions: InvalidQuestion[] }
  | { ok: false; error: string };

export type QuizSelections = Record<string, string[]>;

export interface QuizGrade {
  questionId: string;
  correct: boolean;
  chosen: string[];
}

const JUDGE_OPTIONS: QuizOption[] = [
  { key: 'A', text: '正确' },
  { key: 'B', text: '错误' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function quizStemOf(raw: unknown): string | null {
  return isRecord(raw) && nonEmptyString(raw.stem) ? raw.stem.trim() : null;
}

export function parseQuizBlock(raw: string): QuizParseResult {
  if (raw.length > MAX_QUIZ_RAW_CHARS) {
    return { ok: false, error: `题目数据超过 ${MAX_QUIZ_RAW_CHARS} 字符上限` };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '题目数据不是合法的 JSON' };
  }

  if (!isRecord(data)) return { ok: false, error: '题目数据必须是对象' };
  if (data.version !== QUIZ_PROTOCOL_VERSION) {
    return { ok: false, error: '不支持的题目协议版本' };
  }
  if (!nonEmptyString(data.title)) return { ok: false, error: '缺少标题' };
  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    return { ok: false, error: '没有题目' };
  }
  if (data.questions.length > MAX_QUIZ_QUESTIONS) {
    return { ok: false, error: `题目数量超出上限（最多 ${MAX_QUIZ_QUESTIONS} 道）` };
  }

  const questions: QuizQuestion[] = [];
  const invalidQuestions: InvalidQuestion[] = [];
  const seenIds = new Set<string>();

  for (const [index, rawQuestion] of data.questions.entries()) {
    const parsed = parseQuestion(rawQuestion);
    if (!parsed.ok) {
      invalidQuestions.push({ index, reason: parsed.error, raw: rawQuestion });
      continue;
    }
    // 题目 id 重复会让作答态与答题记录无法归属到唯一题目，整块作废。
    if (seenIds.has(parsed.question.id)) {
      return { ok: false, error: '题目 id 重复' };
    }
    seenIds.add(parsed.question.id);
    questions.push(parsed.question);
  }

  if (questions.length === 0) {
    return { ok: false, error: '没有可作答的题目' };
  }

  return {
    ok: true,
    quiz: { version: QUIZ_PROTOCOL_VERSION, title: data.title.trim(), questions },
    invalidQuestions,
  };
}

function parseQuestion(raw: unknown):
  | { ok: true; question: QuizQuestion }
  | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: '题目必须是对象' };
  if (!nonEmptyString(raw.id)) return { ok: false, error: '缺少题目 id' };
  if (raw.id.trim().length > MAX_QUIZ_ID_CHARS) {
    return { ok: false, error: `题目 id 超过 ${MAX_QUIZ_ID_CHARS} 字符上限` };
  }
  if (raw.type !== 'single' && raw.type !== 'multiple' && raw.type !== 'judge' && raw.type !== 'fill') {
    return { ok: false, error: '不支持的题型' };
  }
  if (!nonEmptyString(raw.stem)) return { ok: false, error: '缺少题干' };

  let options: QuizOption[];
  if (raw.type === 'judge' && raw.options == null) {
    options = JUDGE_OPTIONS.map((option) => ({ ...option }));
  } else if (raw.type === 'fill') {
    // 填空题没有选项。模型把选项塞进来说明它想出的是选择题，按坏题处理，
    // 不静默丢弃字段。
    if (raw.options != null && !(Array.isArray(raw.options) && raw.options.length === 0)) {
      return { ok: false, error: '填空题不应有选项' };
    }
    options = [];
  } else {
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > MAX_QUIZ_OPTIONS) {
      return { ok: false, error: `选项数量必须是 2–${MAX_QUIZ_OPTIONS} 个` };
    }
    options = [];
    const keys = new Set<string>();
    for (const rawOption of raw.options) {
      if (!isRecord(rawOption) || !nonEmptyString(rawOption.key) || !nonEmptyString(rawOption.text)) {
        return { ok: false, error: '选项格式有误' };
      }
      const key = rawOption.key.trim();
      if (key.length > MAX_QUIZ_KEY_CHARS) {
        return { ok: false, error: `选项 key 超过 ${MAX_QUIZ_KEY_CHARS} 字符上限` };
      }
      if (keys.has(key)) return { ok: false, error: '选项 key 重复' };
      keys.add(key);
      options.push({ key, text: rawOption.text.trim() });
    }
  }

  if (!Array.isArray(raw.answer) || raw.answer.length === 0) {
    return { ok: false, error: '缺少答案' };
  }
  if (!raw.answer.every(nonEmptyString)) {
    return { ok: false, error: '答案格式有误' };
  }
  const answers = raw.answer.map((answer) => answer.trim());
  if (new Set(answers).size !== answers.length) {
    return { ok: false, error: '答案重复' };
  }
  if (raw.type === 'single' || raw.type === 'judge') {
    if (answers.length !== 1) return { ok: false, error: '单选题必须有且只有一个答案' };
  } else if (raw.type === 'multiple') {
    if (answers.length < 2) return { ok: false, error: '多选题至少需要两个答案' };
  } else {
    // fill：answer 是可接受写法数组（第 1 项=标准答案），判分做规范化匹配，
    // 每项长度对齐 daemon chosen 的 64 上限。
    if (answers.length > MAX_FILL_ANSWERS) {
      return { ok: false, error: `填空题可接受写法最多 ${MAX_FILL_ANSWERS} 个` };
    }
    if (answers.some((answer) => answer.length > MAX_QUIZ_KEY_CHARS)) {
      return { ok: false, error: `填空题答案超过 ${MAX_QUIZ_KEY_CHARS} 字符上限` };
    }
  }
  if (raw.type !== 'fill') {
    const optionKeys = new Set(options.map((option) => option.key));
    if (answers.some((answer) => !optionKeys.has(answer))) {
      return { ok: false, error: '答案不在选项中' };
    }
  }

  if (!nonEmptyString(raw.explanation)) return { ok: false, error: '缺少解析' };
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    return { ok: false, error: '缺少出处' };
  }
  const sources: QuizSource[] = [];
  for (const rawSource of raw.sources) {
    if (!isRecord(rawSource) || !nonEmptyString(rawSource.path)) {
      return { ok: false, error: '出处格式有误' };
    }
    sources.push({
      path: rawSource.path.trim(),
      ...(nonEmptyString(rawSource.quote) ? { quote: rawSource.quote.trim() } : {}),
    });
  }

  return {
    ok: true,
    question: {
      id: raw.id.trim(),
      type: raw.type,
      stem: raw.stem.trim(),
      options,
      answer: answers,
      explanation: raw.explanation.trim(),
      sources,
    },
  };
}

/**
 * 填空判分的规范化：NFKC（全角→半角）+ trim + 空白折叠 + 小写。
 * 匹配时额外比较「去掉全部空格」的变体，容忍中英文混排的空格习惯差异。
 */
export function normalizeFillText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 无歧义 ASCII 记法 → 符号，判分前对两侧同折：把「键盘顺手写法」与
 * 「符号写法」折进同一等价类。只做记法级等价，不做数学/语义等价
 * （0.5 ≠ 1/2，答案形式本身常是考点，等价写法由模型在 answer 数组里
 * 显式给出）；繁简、去音符等有语义争议或字典级依赖的不进表。
 * 两侧同折，所以普通单词里的部分串命中无害（piano 双方同折仍相等）。
 */
const ASCII_NOTATION_FOLDS: ReadonlyArray<readonly [string, string]> = [
  ['sqrt', '√'],
  ['pi', 'π'],
  ['<=', '≤'],
  ['>=', '≥'],
  ['!=', '≠'],
  ['+-', '±'],
  ['->', '→'],
];

function foldAsciiNotation(value: string): string {
  let folded = value;
  for (const [from, to] of ASCII_NOTATION_FOLDS) folded = folded.split(from).join(to);
  return folded;
}

export function isFillAnswerCorrect(typed: string, answers: string[]): boolean {
  const typedNormalized = foldAsciiNotation(normalizeFillText(typed));
  if (!typedNormalized) return false;
  const typedCondensed = typedNormalized.replace(/ /g, '');
  return answers.some((answer) => {
    const normalized = foldAsciiNotation(normalizeFillText(answer));
    return normalized === typedNormalized || normalized.replace(/ /g, '') === typedCondensed;
  });
}

export function gradeQuiz(quiz: Quiz, selections: QuizSelections): QuizGrade[] {
  return quiz.questions.map((question) => {
    if (question.type === 'fill') {
      // chosen 保留用户原文（落库即输入内容）；判分用规范化匹配。
      // 空文本不该出现（isQuizComplete 已挡），这里防御性地不产出空 chosen——
      // daemon 对空数组整批拒绝，会让全部答题记录静默丢失。
      const typed = selections[question.id]?.[0] ?? '';
      return {
        questionId: question.id,
        correct: isFillAnswerCorrect(typed, question.answer),
        chosen: typed.trim() ? [typed] : [],
      };
    }
    const validKeys = new Set(question.options.map((option) => option.key));
    const chosen = [...new Set((selections[question.id] ?? []).filter((key) => validKeys.has(key)))]
      .sort();
    const expected = [...new Set(question.answer)].sort();
    return {
      questionId: question.id,
      correct: chosen.length === expected.length && chosen.every((key, i) => key === expected[i]),
      chosen,
    };
  });
}

export function isQuizComplete(quiz: Quiz, selections: QuizSelections): boolean {
  return quiz.questions.every((question) => {
    if (question.type === 'fill') {
      return (selections[question.id]?.[0] ?? '').trim().length > 0;
    }
    const validKeys = new Set(question.options.map((option) => option.key));
    return (selections[question.id] ?? []).some((key) => validKeys.has(key));
  });
}

/** 指纹只覆盖 {version, questions}，不含 title / 引导语。 */
export function canonicalQuizJson(quiz: Quiz): string {
  return JSON.stringify({
    version: quiz.version,
    questions: quiz.questions.map((question) => ({
      id: question.id,
      type: question.type,
      stem: question.stem,
      options: question.options.map((option) => ({ key: option.key, text: option.text })),
      answer: [...question.answer],
      explanation: question.explanation,
      sources: question.sources.map((source) => ({
        path: source.path,
        ...(source.quote ? { quote: source.quote } : {}),
      })),
    })),
  });
}

export async function computeQuizFingerprint(quiz: Quiz): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalQuizJson(quiz));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function quizStorageKey(conversationId: string, fingerprint: string): string {
  return `molio.quiz.${conversationId}.${fingerprint}`;
}

export function parseStoredQuizState(
  raw: string | null,
): { selections: QuizSelections; submitted: boolean } | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) return null;
    const selections: QuizSelections = {};
    if (isRecord(data.selections)) {
      for (const [questionId, value] of Object.entries(data.selections)) {
        if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
          selections[questionId] = value;
        }
      }
    }
    return { selections, submitted: data.submitted === true };
  } catch {
    return null;
  }
}

/**
 * 流式过程叙事里剥掉 quiz 围栏：闭合块直接移除；未闭合块移除尾部并报告
 * generating，让 WorkBlock 显示「正在出题…」而不是原始 JSON。
 */
export function stripQuizForStreaming(text: string): { text: string; generating: boolean } {
  let output = '';
  let index = 0;
  let generating = false;

  while (index < text.length) {
    const start = text.indexOf('```quiz', index);
    if (start === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, start);
    const bodyStart = start + '```quiz'.length;
    const close = text.indexOf('```', bodyStart);
    if (close === -1) {
      generating = true;
      break;
    }
    index = close + 3;
  }

  return { text: output.trim(), generating };
}
