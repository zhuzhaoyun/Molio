/**
 * Import a skill from pasted SKILL.md raw text or a local folder path.
 * v1 supports these two local sources; URL fetch + marketplace browse land in v1.5.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { SkillManifestEntry } from '@molio/contracts';
import type { SkillPathsOpts } from './paths.js';
import { parseSkillMd } from './skillmd.js';
import { createSkill } from './store.js';

export class SkillImportError extends Error {
  code: 'NOT_FOUND' | 'BAD_REQUEST';
  constructor(code: 'NOT_FOUND' | 'BAD_REQUEST', message: string) {
    super(message);
    this.name = 'SkillImportError';
    this.code = code;
  }
}

function deriveName(parsed: { name: string }, fallback: string): string {
  return parsed.name.trim() || fallback;
}

/** Import from pasted SKILL.md content (frontmatter parsed if present). */
export function importFromRaw(db: Database.Database, raw: string, opts?: SkillPathsOpts): SkillManifestEntry {
  if (!raw || !raw.trim()) {
    throw new SkillImportError('BAD_REQUEST', '导入内容为空');
  }
  const parsed = parseSkillMd(raw);
  if (!parsed.instructions.trim()) {
    throw new SkillImportError('BAD_REQUEST', '未能从内容中解析出技能指令');
  }
  return createSkill(
    db,
    { name: deriveName(parsed, '导入的技能'), description: parsed.description, enabled: true, builtIn: false },
    parsed.instructions,
    opts,
  );
}

/** A resolved import source: either a multi-file directory or a single .md file. */
type ResolvedSource =
  /** Directory with a root SKILL.md → copied wholesale (multi-file skill). */
  | { type: 'dir'; dir: string; skillMd: string }
  /** A lone .md file → imported as a single-file skill. */
  | { type: 'file'; skillMd: string };

/**
 * Resolve a user-provided path to an import source.
 *
 * Accepts either:
 *   - a directory whose ROOT holds a SKILL.md (multi-file skills keep reference/
 *     script siblings next to SKILL.md — the whole directory is imported), or
 *   - a direct path to a .md file (users naturally paste file paths such as
 *     `C:\Users\me\Downloads\SKILL (1).md` — appending `\SKILL.md` to that is
 *     wrong).
 */
function resolveSource(input: string): ResolvedSource {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(input);
  } catch {
    stat = null;
  }

  if (stat?.isDirectory()) {
    const skillMd = path.join(input, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      throw new SkillImportError('NOT_FOUND', `该文件夹根目录没有 SKILL.md：${input}`);
    }
    return { type: 'dir', dir: input, skillMd };
  }

  // Direct file path → single-file skill.
  if (stat?.isFile()) {
    return { type: 'file', skillMd: input };
  }

  // Path doesn't exist. If it looks like a direct .md file, report that exact
  // path rather than confusingly appending `\SKILL.md` to a file-looking path.
  if (/\.md$/i.test(input)) {
    throw new SkillImportError('NOT_FOUND', `未找到文件：${input}`);
  }
  throw new SkillImportError('NOT_FOUND', `未找到文件夹或 SKILL.md：${input}`);
}

/**
 * Import a skill from a local path: a directory containing a root SKILL.md
 * (imported as a whole multi-file directory) or a single .md file.
 */
export function importFromFolder(db: Database.Database, folderPath: string, opts?: SkillPathsOpts): SkillManifestEntry {
  if (!folderPath || !folderPath.trim()) {
    throw new SkillImportError('BAD_REQUEST', '文件夹路径为空');
  }
  const src = resolveSource(folderPath.trim());
  const raw = fs.readFileSync(src.skillMd, 'utf8');
  const parsed = parseSkillMd(raw);
  if (!parsed.instructions.trim()) {
    throw new SkillImportError('BAD_REQUEST', '该 SKILL.md 没有可导入的指令正文');
  }
  const fallbackName =
    src.type === 'dir'
      ? path.basename(path.resolve(src.dir))
      : path.basename(src.skillMd).replace(/\.md$/i, '');
  return createSkill(
    db,
    {
      name: deriveName(parsed, fallbackName),
      description: parsed.description,
      enabled: true,
      builtIn: false,
      // A directory is copied verbatim (SKILL.md + siblings); a lone file uses
      // the generated-SKILL.md path (sourceDir omitted).
      ...(src.type === 'dir' ? { sourceDir: src.dir } : {}),
    },
    parsed.instructions,
    opts,
  );
}
