/**
 * Import a skill from pasted SKILL.md raw text or a local folder path.
 * v1 supports these two local sources; URL fetch + marketplace browse land in v1.5.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parseSkillMd } from '@molio/contracts';
import type { SkillManifestEntry, SkillImportIssue, ParsedSkillMd } from '@molio/contracts';
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

/** Inspected source + everything preview and import both need. */
export interface InspectedSkillSource {
  ok: boolean;
  /** null when the source could not be resolved/read at all. */
  entry: { type: 'dir'; dir: string } | { type: 'file'; skillMd: string } | null;
  name: string;
  nameFallback: boolean;
  description: string;
  descriptionFallback: boolean;
  instructions: string;
  entryFile: string | null;
  files: { path: string; size: number }[];
  truncated: boolean;
  issues: SkillImportIssue[];
}

function fail(issues: SkillImportIssue[]): InspectedSkillSource {
  return {
    ok: false, entry: null, name: '', nameFallback: false, description: '',
    descriptionFallback: false, instructions: '', entryFile: null,
    files: [], truncated: false, issues,
  };
}

/** Map the first error-level issue back to the legacy SkillImportError codes. */
export function inspectedErrorToImportError(issues: SkillImportIssue[]): SkillImportError {
  const first = issues.find((i) => i.level === 'error')!;
  const code = first.code === 'NO_ENTRY' || first.code === 'SOURCE_UNREADABLE' ? 'NOT_FOUND' : 'BAD_REQUEST';
  return new SkillImportError(code, first.message);
}

/** Walk `dir` collecting relative-posix paths + sizes; stop and flag at the limits. */
function listFolderFiles(dir: string): { files: { path: string; size: number }[]; truncated: boolean; issues: SkillImportIssue[] } {
  const files: { path: string; size: number }[] = [];
  const issues: SkillImportIssue[] = [];
  let bytes = 0;
  let truncated = false;
  const walk = (d: string): void => {
    if (truncated) return;
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
        continue; // broken symlink — copyDirSync will skip/fail on it later
      }
      files.push({ path: path.relative(dir, p).split(path.sep).join('/'), size });
      bytes += size;
      if (files.length > MAX_IMPORT_FILES) {
        issues.push({ level: 'error', code: 'TOO_MANY_FILES', message: `导入文件夹包含的文件数超过上限（最多 ${MAX_IMPORT_FILES} 个文件）` });
        truncated = true;
        return;
      }
      if (bytes > MAX_IMPORT_BYTES) {
        issues.push({ level: 'error', code: 'TOO_LARGE', message: `导入文件夹总大小超过上限（最大 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB）` });
        truncated = true;
        return;
      }
    }
  };
  walk(dir);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, truncated, issues };
}

function buildInspected(
  entry: InspectedSkillSource['entry'],
  parsed: ParsedSkillMd,
  fallbackName: string,
  entryFile: string | null,
  files: { path: string; size: number }[],
  truncated: boolean,
  issues: SkillImportIssue[],
): InspectedSkillSource {
  const nameFallback = !parsed.nameFromFrontmatter;
  const descriptionFallback = !parsed.description.trim();
  if (nameFallback) {
    issues.push({ level: 'warning', code: 'NAME_FALLBACK', message: `缺少 frontmatter 名称，将使用「${parsed.name.trim() || fallbackName}」` });
  }
  if (descriptionFallback) {
    issues.push({ level: 'warning', code: 'DESCRIPTION_FALLBACK', message: '缺少描述，建议导入后在列表中补充' });
  }
  return {
    ok: !issues.some((i) => i.level === 'error'),
    entry,
    name: parsed.name.trim() || fallbackName,
    nameFallback,
    description: parsed.description,
    descriptionFallback,
    instructions: parsed.instructions,
    entryFile,
    files,
    truncated,
    issues,
  };
}

/**
 * Inspect an import source WITHOUT touching the database: resolve the path /
 * parse the raw text, collect the file list and human-readable issues. This is
 * the SINGLE source of truth shared by the preview endpoint and the import
 * handlers, so the preview can never disagree with what import would do.
 */
export function inspectSkillSource(input: { raw: string } | { folderPath: string }): InspectedSkillSource {
  if ('raw' in input) {
    const raw = input.raw;
    if (!raw || !raw.trim()) {
      return fail([{ level: 'error', code: 'EMPTY_BODY', message: '导入内容为空' }]);
    }
    const parsed = parseSkillMd(raw);
    if (!parsed.instructions.trim()) {
      return fail([{ level: 'error', code: 'EMPTY_BODY', message: '未能从内容中解析出技能指令' }]);
    }
    return buildInspected(null, parsed, '导入的技能', null, [], false, []);
  }

  const p = input.folderPath.trim();
  if (!p) {
    return fail([{ level: 'error', code: 'SOURCE_UNREADABLE', message: '路径为空' }]);
  }
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(p);
  } catch {
    stat = null;
  }
  if (!stat) {
    return fail([{ level: 'error', code: 'SOURCE_UNREADABLE', message: `无法读取该路径，请确认它在运行 Molio 的机器上存在：${p}` }]);
  }

  if (stat.isDirectory()) {
    const skillMdPath = path.join(p, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return fail([{ level: 'error', code: 'NO_ENTRY', message: `未找到 SKILL.md，这不是一个技能文件夹：${p}。请确认文件夹里有 SKILL.md，或改选它的上一级目录` }]);
    }
    const { files, truncated, issues } = listFolderFiles(p);
    if (truncated) return { ...fail(issues), truncated: true };
    let raw: string;
    try {
      raw = fs.readFileSync(skillMdPath, 'utf8');
    } catch {
      return fail([{ level: 'error', code: 'SOURCE_UNREADABLE', message: `无法读取 ${p} 下的 SKILL.md` }]);
    }
    const parsed = parseSkillMd(raw);
    if (!parsed.instructions.trim()) {
      return fail([{ level: 'error', code: 'EMPTY_BODY', message: '该 SKILL.md 没有可导入的指令正文' }]);
    }
    const fallbackName = path.basename(path.resolve(p));
    return buildInspected({ type: 'dir', dir: p }, parsed, fallbackName, 'SKILL.md', files, false, issues);
  }

  if (stat.isFile()) {
    const size = stat.size;
    if (size > MAX_IMPORT_BYTES) {
      return fail([{ level: 'error', code: 'TOO_LARGE', message: `导入文件大小超过上限（最大 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB）` }]);
    }
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      return fail([{ level: 'error', code: 'SOURCE_UNREADABLE', message: `无法读取文件：${p}` }]);
    }
    const parsed = parseSkillMd(raw);
    if (!parsed.instructions.trim()) {
      return fail([{ level: 'error', code: 'EMPTY_BODY', message: '该文件没有可导入的指令正文' }]);
    }
    const fallbackName = path.basename(p).replace(/\.md$/i, '');
    return buildInspected(
      { type: 'file', skillMd: p }, parsed, fallbackName,
      path.basename(p), [{ path: path.basename(p), size }], false, [],
    );
  }

  return fail([{ level: 'error', code: 'NO_ENTRY', message: `未找到文件夹或 SKILL.md：${p}` }]);
}

type ImportOverrides = { name?: string; description?: string };

/** Import from pasted SKILL.md content (frontmatter parsed if present). */
export function importFromRaw(
  db: Database.Database, raw: string, opts?: SkillPathsOpts, overrides?: ImportOverrides,
): SkillManifestEntry {
  const inspected = inspectSkillSource({ raw });
  if (!inspected.ok) throw inspectedErrorToImportError(inspected.issues);
  return createSkill(
    db,
    {
      name: overrides?.name?.trim() || inspected.name,
      description: overrides?.description !== undefined ? overrides.description.trim() : inspected.description,
      enabled: true, builtIn: false,
    },
    inspected.instructions,
    opts,
  );
}

/** Import from a local path: a directory containing a root SKILL.md (whole
 * multi-file directory) or a single .md file (single-file skill). */
export function importFromFolder(
  db: Database.Database, folderPath: string, opts?: SkillPathsOpts, overrides?: ImportOverrides,
): SkillManifestEntry {
  const inspected = inspectSkillSource({ folderPath });
  if (!inspected.ok) throw inspectedErrorToImportError(inspected.issues);
  return createSkill(
    db,
    {
      name: overrides?.name?.trim() || inspected.name,
      description: overrides?.description !== undefined ? overrides.description.trim() : inspected.description,
      enabled: true, builtIn: false,
      // A directory is copied verbatim (SKILL.md + siblings); a lone file uses
      // the generated-SKILL.md path (sourceDir omitted).
      ...(inspected.entry?.type === 'dir' ? { sourceDir: inspected.entry.dir } : {}),
    },
    inspected.instructions,
    opts,
  );
}
