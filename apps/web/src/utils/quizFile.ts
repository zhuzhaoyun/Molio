import type { QuizQuestion } from './quiz';

export interface QuizFileIO {
  readFile(vaultId: string, filePath: string): Promise<unknown>;
  writeFile(vaultId: string, filePath: string, content: string): Promise<void>;
}

export type QuizQuestionOutcome = 'correct' | 'wrong' | 'ungraded';

/** 一道题在文件里的全部事实（选中题的「快照」，与卡片当前状态解耦）。 */
export interface QuizFileQuestion {
  /** 卡片序号（questions 下标 + 1），与 gradingMapKey 同口径。 */
  number: number;
  question: QuizQuestion;
  outcome: QuizQuestionOutcome;
  /** null = 取不到（大题正文没落库）；'' = 用户没作答。 */
  given: string | null;
  grading?: { score: number; total: number };
}

export interface QuizFileInput {
  title: string;
  version: number;
  /** 完整 sha-256；null 时不写该字段。 */
  fingerprint: string | null;
  totalQuestions: number;
  /** 已选中的子集，按原题序。 */
  questions: QuizFileQuestion[];
}

export function quizDateStamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 标题只做人读的一段文件名：去掉路径分隔符/控制字符/Windows 保留字符，
 * 合并空白，截断到 60 字符。`..` 不会残留（点号在首尾被剥掉）。
 */
export function sanitizeQuizTitle(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .slice(0, 60)
    .trim();
  return cleaned || '练习';
}

export function buildQuizFilePath(date: string, title: string): string {
  return `题库/${date}-${sanitizeQuizTitle(title)}.md`;
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

/**
 * 题库文件写在 `题库/` 子目录，而题面里的图片多是**库根相对**路径
 * （`wiki/images/x.png`）。KB 渲染按笔记所在目录解析相对路径，存进题库后
 * 会去找 `题库/wiki/images/x.png` → 全裂。这里统一补一层 `../`。
 *
 * 代码块里的示例不动；带协议 / `//` / `#` / 绝对路径 / 已是 `../` 的都不动。
 */
export function prefixRelativeImagePaths(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(IMAGE_RE, (_whole, alt: string, dest: string, title?: string) => {
        if (NON_LOCAL_RE.test(dest) || dest.startsWith('../')) return _whole;
        return `![${alt}](../${dest}${title ?? ''})`;
      });
    })
    .join('\n');
}

/** 答案行：多选/单选用顿号；填空有多个可接受写法，用斜杠区分。 */
function answerText(question: QuizQuestion): string {
  return question.type === 'fill' ? question.answer.join(' / ') : question.answer.join('、');
}

/**
 * 「你的答案」：分不清「取不到」与「没作答」是最伤人的——取不到写「见会话」，
 * 没作答写「未作答」，判过的才附 ✓/✗。
 */
function givenText(entry: QuizFileQuestion): string {
  if (entry.given === null) return '见会话';
  if (entry.given === '') return '未作答';
  if (entry.outcome === 'correct') return `${entry.given} ✓`;
  if (entry.outcome === 'wrong') return `${entry.given} ✗`;
  return entry.given;
}

/** 大题正文常是多行：单行接在冒号后，多行改引用块，避免撑破 markdown。 */
function answerLines(value: string): string[] {
  if (!value.includes('\n')) return [`**你的答案**：${value}`];
  return ['**你的答案**：', ...value.split('\n').map((line) => `> ${line}`)];
}

function questionBlock(entry: QuizFileQuestion): string {
  const { question } = entry;
  const lines: string[] = [`## 第 ${entry.number} 题`, '', prefixRelativeImagePaths(question.stem).trim()];

  if (question.options.length > 0) {
    lines.push('');
    for (const option of question.options) lines.push(`- ${option.key}. ${option.text}`);
  }

  if (question.type === 'subject') {
    lines.push('', '**答案**：');
    question.answer.forEach((point, index) => lines.push(`${index + 1}. ${point}`));
  } else {
    lines.push('', `**答案**：${answerText(question)}`);
  }

  lines.push('', ...answerLines(givenText(entry)));

  if (entry.grading) {
    lines.push('', `**批改**：${entry.grading.score}/${entry.grading.total}`);
  }

  const explanation = prefixRelativeImagePaths(question.explanation).trim();
  if (explanation) lines.push('', `**解析**：${explanation}`);

  if (question.sources.length > 0) {
    lines.push('', `出处：${question.sources.map((source) => `[[${source.path}]]`).join('、')}`);
  }

  return lines.join('\n');
}

/**
 * 人读 markdown + 机器可读 frontmatter。
 *
 * frontmatter 里的模型产出标量一律 JSON.stringify：标题里的 `: ` 或 `#` 会
 * 让 YAML 解析失败，doocs 会把整篇（含 frontmatter）当正文渲染。
 * 正文不再写 ```quiz 围栏——文件是给人复习的，不是回灌协议。
 */
export function serializeQuizMarkdown(input: QuizFileInput, createdAt = new Date()): string {
  const questions = input.questions;
  const sources = [...new Set(questions.flatMap((entry) => entry.question.sources.map((source) => source.path)))];

  const frontmatter = ['---', 'type: quiz', `created: ${createdAt.toISOString()}`];
  if (input.fingerprint) frontmatter.push(`quiz_fingerprint: ${JSON.stringify(input.fingerprint)}`);
  frontmatter.push(
    `quiz_protocol_version: ${input.version}`,
    `quiz_title: ${JSON.stringify(input.title)}`,
    `quiz_saved_questions: ${questions.length}`,
    `quiz_total_questions: ${input.totalQuestions}`,
  );
  if (questions.length > 0) {
    frontmatter.push('quiz_question_ids:');
    for (const entry of questions) frontmatter.push(`  - ${JSON.stringify(entry.question.id)}`);
  }
  if (sources.length > 0) {
    frontmatter.push('sources:');
    for (const source of sources) frontmatter.push(`  - ${JSON.stringify(source)}`);
  }
  frontmatter.push('---');

  const head = [
    frontmatter.join('\n'),
    `# ${input.title}`,
    `> ${quizDateStamp(createdAt)} 保存 · ${questions.length}/${input.totalQuestions} 题`,
  ].join('\n\n');

  return `${[head, ...questions.map(questionBlock)].join('\n\n---\n\n')}\n`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /\b404\b/.test(error.message);
}

/**
 * 写入 `<vault>/题库/YYYY-MM-DD-<标题>.md`，同名时追加 -2/-3…，绝不覆盖。
 * 读取检查失败（非 404）时直接抛错——宁可保存失败，也不猜文件名。
 */
export async function saveQuizToVault(
  vaultId: string,
  input: QuizFileInput,
  io: QuizFileIO,
  now = new Date(),
): Promise<string> {
  const base = buildQuizFilePath(quizDateStamp(now), input.title).replace(/\.md$/, '');
  const content = serializeQuizMarkdown(input, now);

  for (let sequence = 1; sequence <= 50; sequence += 1) {
    const filePath = sequence === 1 ? `${base}.md` : `${base}-${sequence}.md`;
    try {
      await io.readFile(vaultId, filePath);
      // 已存在 → 试下一个序号。
    } catch (error) {
      if (isNotFound(error)) {
        await io.writeFile(vaultId, filePath, content);
        return filePath;
      }
      throw error;
    }
  }

  throw new Error('无法生成不冲突的题库文件名');
}
