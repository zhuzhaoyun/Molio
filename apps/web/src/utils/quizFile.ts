import type { Quiz } from './quiz';

export interface QuizFileIO {
  readFile(vaultId: string, filePath: string): Promise<unknown>;
  writeFile(vaultId: string, filePath: string, content: string): Promise<void>;
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

export function serializeQuizMarkdown(quiz: Quiz, createdAt = new Date()): string {
  const sources = [...new Set(
    quiz.questions.flatMap((question) => question.sources.map((source) => source.path)),
  )];
  const lines = ['---', 'type: quiz', `created: ${createdAt.toISOString()}`];
  if (sources.length > 0) {
    lines.push('sources:');
    for (const source of sources) lines.push(`  - ${JSON.stringify(source)}`);
  }
  lines.push(
    '---',
    '',
    `# ${quiz.title}`,
    '',
    '```quiz',
    JSON.stringify({ version: quiz.version, title: quiz.title, questions: quiz.questions }, null, 2),
    '```',
    '',
  );
  return lines.join('\n');
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
  quiz: Quiz,
  io: QuizFileIO,
  now = new Date(),
): Promise<string> {
  const base = buildQuizFilePath(quizDateStamp(now), quiz.title).replace(/\.md$/, '');
  const content = serializeQuizMarkdown(quiz, now);

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
