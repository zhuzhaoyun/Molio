/**
 * Built-in curated skills shipped with Molio, seeded idempotently into the user's
 * library on daemon startup. Content lives as in-code strings for v1 (no packaging
 * changes); a bundled-directory approach is deferred to v1.5.
 *
 * Seeding is idempotent: an existing manifest entry (by id) is NEVER overwritten,
 * so the user's toggle state and edits are preserved across restarts/upgrades.
 */
import type { SkillPathsOpts } from './paths.js';
import { createSkill, loadManifest, reconcile } from './store.js';

export interface BuiltinSeed {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

export const BUILTIN_SKILLS_SEEDS: BuiltinSeed[] = [
  {
    id: 'write-article',
    name: '写文章',
    description: '根据话题或大纲写出一篇结构清晰、可直接发布的文章（博客 / 公众号 / 专栏）。',
    enabled: true,
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
    enabled: true,
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
    enabled: true,
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

/** Seed any missing built-in skills into the library. Idempotent — never overwrites existing entries. */
export function seedBuiltinSkills(opts?: SkillPathsOpts): void {
  const manifest = loadManifest(opts);
  const existing = new Set(manifest.skills.map((s) => s.id));

  for (const seed of BUILTIN_SKILLS_SEEDS) {
    if (existing.has(seed.id)) continue; // preserve user's toggle / edits
    createSkill(
      { id: seed.id, name: seed.name, description: seed.description, enabled: seed.enabled, builtIn: true },
      seed.instructions,
      opts,
    );
  }
}

/** Startup entry: seed built-ins then reconcile the `~/.claude/skills/` sync. Idempotent. */
export function initSkillLibrary(opts?: SkillPathsOpts): void {
  try {
    seedBuiltinSkills(opts);
    reconcile(opts);
  } catch (err) {
    console.error('[skills] Failed to initialize skill library:', err instanceof Error ? err.message : err);
  }
}
