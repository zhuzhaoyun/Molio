/**
 * Import a skill from pasted SKILL.md raw text or a local folder path.
 * v1 supports these two local sources; URL fetch + marketplace browse land in v1.5.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parseSkillMd } from '@molio/contracts';
import type { SkillManifestEntry } from '@molio/contracts';
import type { SkillPathsOpts } from './paths.js';
import { createSkill } from './store.js';

export class SkillImportError extends Error {
  code: 'NOT_FOUND' | 'BAD_REQUEST';
  constructor(code: 'NOT_FOUND' | 'BAD_REQUEST', message: string) {
    super(message);
    this.name = 'SkillImportError';
    this.code = code;
  }
}

/**
 * Safety limits for folder imports. The daemon copies the chosen directory
 * VERBATIM into the library, so a path pointing at a huge tree (e.g. a whole
 * drive by mistake) would otherwise fill the disk. Skills are text-heavy; the
 * limits are far above any realistic skill yet stop catastrophic foot-guns.
 */
export const MAX_IMPORT_FILES = 1000;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // 100 MB

/** Walk `dir` and reject it when it exceeds the import limits. */
function assertFolderWithinLimits(dir: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(p).size; // follows symlinks, like copyDirSync does
      } catch {
        continue; // broken symlink etc. — copyDirSync will skip/fail on it later
      }
      files += 1;
      bytes += size;
      if (files > MAX_IMPORT_FILES) {
        throw new SkillImportError(
          'BAD_REQUEST',
          `导入文件夹包含的文件数超过上限（最多 ${MAX_IMPORT_FILES} 个文件）`,
        );
      }
      if (bytes > MAX_IMPORT_BYTES) {
        throw new SkillImportError(
          'BAD_REQUEST',
          `导入文件夹总大小超过上限（最大 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB）`,
        );
      }
    }
  };
  walk(dir);
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
  // Multi-file imports copy the whole tree — enforce size limits before any
  // bytes are written (a lone .md file is trivially small, skip the walk).
  if (src.type === 'dir') assertFolderWithinLimits(src.dir);
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
