/**
 * Import a skill from pasted SKILL.md raw text or a local folder path.
 * v1 supports these two local sources; URL fetch + marketplace browse land in v1.5.
 */
import fs from 'node:fs';
import path from 'node:path';
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
export function importFromRaw(raw: string, opts?: SkillPathsOpts): SkillManifestEntry {
  if (!raw || !raw.trim()) {
    throw new SkillImportError('BAD_REQUEST', '导入内容为空');
  }
  const parsed = parseSkillMd(raw);
  if (!parsed.instructions.trim()) {
    throw new SkillImportError('BAD_REQUEST', '未能从内容中解析出技能指令');
  }
  return createSkill(
    { name: deriveName(parsed, '导入的技能'), description: parsed.description, enabled: true, builtIn: false },
    parsed.instructions,
    opts,
  );
}

/** Import from a local folder containing a SKILL.md. */
export function importFromFolder(folderPath: string, opts?: SkillPathsOpts): SkillManifestEntry {
  if (!folderPath || !folderPath.trim()) {
    throw new SkillImportError('BAD_REQUEST', '文件夹路径为空');
  }
  const skillMd = path.join(folderPath, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    throw new SkillImportError('NOT_FOUND', `未找到 SKILL.md：${skillMd}`);
  }
  const raw = fs.readFileSync(skillMd, 'utf8');
  const parsed = parseSkillMd(raw);
  if (!parsed.instructions.trim()) {
    throw new SkillImportError('BAD_REQUEST', '该 SKILL.md 没有可导入的指令正文');
  }
  const fallbackName = path.basename(path.resolve(folderPath));
  return createSkill(
    { name: deriveName(parsed, fallbackName), description: parsed.description, enabled: true, builtIn: false },
    parsed.instructions,
    opts,
  );
}
