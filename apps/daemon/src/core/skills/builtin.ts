/**
 * Built-in skills shipped with Molio, seeded idempotently into the daemon's
 * `skills` table on startup.
 *
 * Two flavors are seeded here:
 *  - **bundled** (docling / wiki-* / remotion / wechat-article-extractor): the
 *    real "skills" users see and toggle. Their content is multi-file and lives
 *    under the app resources (`tools/skills/<slug>/`); only a metadata row is
 *    inserted (createSkill skips writing a library SKILL.md for kind='bundled').
 *    name/description are read from the shipped SKILL.md frontmatter so the UI
 *    stays in sync with what the agent actually gets; hardcoded fallbacks cover
 *    a missing/unreadable source dir.
 *  - **core** (writing trio): Molio's core job. Hidden + always-on + not
 *    configurable, but their behavior is preserved — the body is written to
 *    `~/.molio/skills/<id>/SKILL.md` and synced into every vault like a library
 *    skill (see vault-config.ts).
 *
 * Seeding is idempotent: an existing row (by id) only gets its name/description
 * refreshed — `enabled`/`core` are NEVER overwritten, so the user's toggle state
 * survives restarts/upgrades.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { SkillPathsOpts } from './paths.js';
import { parseSkillMd } from './skillmd.js';
import { createSkill, getSkill, listSkills } from './store.js';
import { BUILTIN_SKILLS, resolveSkillsSourceDir } from '../skill-installer.js';

/** Fallback display metadata for bundled skills if the shipped SKILL.md can't be read. */
const BUNDLED_FALLBACK: Record<string, { name: string; description: string }> = {
  'wechat-article-extractor': {
    name: '微信文章提取',
    description: '提取微信公众号文章（mp.weixin.qq.com）内容为 Markdown。',
  },
  docling: {
    name: 'docling',
    description: '将 PDF / Office / 图片 / 音视频转换为 Markdown（GPU OCR + 版面 + 表格）。',
  },
  'wiki-build': { name: 'wiki-build', description: '构建/重建本地知识库的 Wiki。' },
  'wiki-ingest': { name: 'wiki-ingest', description: '将源文件/资料增量导入（入库）到现有 wiki。' },
  'wiki-lint': { name: 'wiki-lint', description: '对知识库 Wiki 做健康检查/质量审查。' },
  'wiki-save': { name: 'wiki-save', description: '将当前对话中有价值的内容归档为 wiki 页面。' },
  'wiki-query': { name: 'wiki-query', description: '基于已构建的 wiki 和源文件回答库内问题/为库内任务提供依据。' },
  remotion: { name: 'remotion', description: '用 React/TypeScript 制作视频并渲染为 MP4。' },
};

/** Read a bundled skill's display name/description from its shipped SKILL.md frontmatter. */
function readBundledMeta(slug: string, sourceDir: string): { name: string; description: string } {
  const fallback = BUNDLED_FALLBACK[slug] ?? { name: slug, description: '' };
  try {
    const md = path.join(sourceDir, slug, 'SKILL.md');
    if (!fs.existsSync(md)) return fallback;
    const parsed = parseSkillMd(fs.readFileSync(md, 'utf8'));
    return {
      name: parsed.name.trim() || fallback.name,
      description: parsed.description.trim() || fallback.description,
    };
  } catch {
    return fallback;
  }
}

/** The writing trio — Molio's core job. Hidden, always-on, not configurable. */
export interface CoreSeed {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

export const CORE_SKILLS_SEEDS: CoreSeed[] = [
  {
    id: 'write-article',
    name: '写文章',
    description: '根据话题或大纲写出一篇结构清晰、可直接发布的文章（博客 / 公众号 / 专栏）。',
    instructions: [
      '当用户想写一篇文章（博客、公众号、专栏、随笔等）时使用本技能。',
      '',
      '流程：',
      '1. 先确认主题、目标读者、篇幅与语气；信息不足时给出 2-3 个具体选项让用户挑，而不是空泛追问。',
      '2. 产出一个简短大纲（3-5 个小标题）让用户确认后，再展开全文。',
      '3. 正文要求：开头有钩子、段落短、有小标题分隔、结尾有收束；避免空话套话。',
      '4. 默认输出 Markdown。写完后主动问用户是否需要排版（doocs/md）或发布到平台。',
    ].join('\n'),
  },
  {
    id: 'summarize',
    name: '总结提炼',
    description: '把长文本 / 会议记录 / 资料压缩成结构化要点摘要，保留关键信息与结论。',
    instructions: [
      '当用户要求总结、提炼、概括一段较长内容时使用本技能。',
      '',
      '输出结构：',
      '- **一句话结论**：全文最核心的一点。',
      '- **关键要点**：3-7 条，bullet 形式，每条一行，按重要性排序。',
      '- **数据/事实**：出现的关键数字、时间、人名（若有）。',
      '- **行动项**：需要跟进的事项（若有）。',
      '',
      '要求：忠于原文、不臆造；没有的部分直接省略对应小节；篇幅控制在一屏内。',
    ].join('\n'),
  },
  {
    id: 'polish-rewrite',
    name: '润色改写',
    description: '在保持原意的前提下润色文字，改善表达、修正语病、统一风格。',
    instructions: [
      '当用户要求润色、改写、优化一段文字时使用本技能。',
      '',
      '规则：',
      '1. 保持原意不变，不要增删实质信息。',
      '2. 修正语病、错别字、标点；改善句式让表达更顺畅。',
      '3. 默认保持原文语气；如用户指定风格（更正式 / 更口语 / 更简洁）则向其靠拢。',
      '4. 直接给出改写后的全文；如果改动较大，在末尾用 1-2 句说明主要改了哪些方面。',
    ].join('\n'),
  },
];

/**
 * Seed all built-in skills into the `skills` table. Idempotent — an existing row
 * only has its name/description refreshed; `enabled`/`core` are never touched.
 */
export function seedBuiltinSkills(db: Database.Database, opts?: SkillPathsOpts): void {
  const sourceDir = resolveSkillsSourceDir();

  // 1. Bundled skills (multi-file, shipped) — shown + configurable.
  for (const slug of BUILTIN_SKILLS) {
    const meta = readBundledMeta(slug, sourceDir);
    const existing = getSkill(db, slug);
    if (existing) {
      refreshMeta(db, slug, meta.name, meta.description);
      continue;
    }
    createSkill(
      db,
      { id: slug, name: meta.name, description: meta.description, enabled: true, builtIn: true, kind: 'bundled' },
      '',
      opts,
    );
  }

  // 2. Core writing trio — hidden + always-on + not configurable (behavior preserved).
  for (const seed of CORE_SKILLS_SEEDS) {
    const existing = getSkill(db, seed.id);
    if (existing) {
      refreshMeta(db, seed.id, seed.name, seed.description);
      continue;
    }
    createSkill(
      db,
      {
        id: seed.id,
        name: seed.name,
        description: seed.description,
        enabled: true,
        builtIn: true,
        kind: 'library',
        core: true,
      },
      seed.instructions,
      opts,
    );
  }
}

/** Update only name/description (+updatedAt) of an existing row — never enabled/core. */
function refreshMeta(db: Database.Database, id: string, name: string, description: string): void {
  db.prepare('UPDATE skills SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
    name,
    description,
    Date.now(),
    id,
  );
}

/** Total number of built-in skills seeded (bundled + core) — handy for tests/diagnostics. */
export function countSeededBuiltins(db: Database.Database): number {
  return listSkills(db).filter((s) => s.builtIn).length;
}

/**
 * Startup entry: seed built-ins into the `skills` table (the master-switch
 * source). Idempotent. Per-vault sync is a separate step (see index.ts:
 * reconcileAllVaults after this, then cleanupLegacyGlobalSync) — seeding never
 * touches any vault.
 */
export function initSkillLibrary(db: Database.Database, opts?: SkillPathsOpts): void {
  try {
    seedBuiltinSkills(db, opts);
  } catch (err) {
    console.error('[skills] Failed to initialize skill library:', err instanceof Error ? err.message : err);
  }
}
