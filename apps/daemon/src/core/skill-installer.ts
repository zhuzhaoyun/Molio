/**
 * Install built-in Molio skills into a vault's .claude/skills/ directory.
 * Called during vault creation / import so that runtime CLIs (Claude Code, etc.)
 * automatically discover the skills on startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThrottledWarn } from './throttled-warn.js';
import { mirrorDirIfChanged } from './skills/dirsync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The "skills source not found" warnings can fire once per skill for every
// vault on each sync when the packaged skills dir is missing/broken — bounded
// per run but multiplied by (skills × vaults). Throttle per source path so a
// broken install surfaces once, not once-per-skill-per-vault (see
// throttled-warn.ts). Genuine per-skill install failures stay on console.error.
const skillWarn = new ThrottledWarn();

/** Reset the skills throttle — test hook so cases start from a clean slate. */
export function resetSkillWarnState(): void {
  skillWarn.reset();
}

/**
 * Bundled skills shipped with Molio. These are the real "skills" users see and
 * toggle in the skill library UI (kind='bundled' in the `skills` table). Their
 * content is multi-file and lives under `tools/skills/<slug>/`; the whole
 * directory is synced to `<vault>/.claude/skills/<slug>/` (plain name, no
 * `molio--` prefix — wiki-save references wiki-build/scripts by path, and the
 * CLAUDE.md rules below reference these skills by name).
 */
export const BUILTIN_SKILLS = [
  'wechat-article-extractor',
  // docling replaces the old docx/pdf/pptx/xlsx skills — one unified skill for
  // all office→markdown conversions (GPU-accelerated OCR + layout + tables).
  'docling',
  // Wiki operations — on-demand skills the agent invokes by intent
  // (构建/入库/健康检查/归档/问答). Replaces the old wikiOperation prompt-prepend
  // path so chat-typed verbs and UI buttons hit the same procedure.
  'wiki-build',
  'wiki-ingest',
  'wiki-lint',
  'wiki-save',
  // wiki-query — 知识库问答检索流程。Replaces the broken --append-system-prompt-file
  // injection (silently dropped by the CLI): retrieval now lives in an on-demand
  // skill, triggered by the always-on CLAUDE.md rule below + the KB qa panel.
  'wiki-query',
  // Remotion — programmatic video creation in React/TypeScript, rendered to
  // MP4. Used by the /remotion command to scaffold video projects, animate
  // with interpolate/spring, sequence scenes, add audio/captions, and render.
  'remotion',
];

/**
 * True if `dir` actually holds the shipped built-in skills (rather than being
 * some unrelated directory that happens to be named "skills"). We probe for a
 * known built-in skill's SKILL.md as the marker.
 *
 * This guard matters because `src/core/skills/` is ALSO a source-code module
 * (the user skill library) that compiles to `dist/src/core/skills/`. A bare
 * existence check on a "skills" directory would mistake that module dir for the
 * packaged built-in skills dir and silently install nothing.
 */
function isBuiltinSkillsDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'wechat-article-extractor', 'SKILL.md'));
}

/**
 * Resolve the source directory for built-in skills.
 * In dev (tsx): __dirname = src/core/ → ../tools/skills/ exists
 * In prod (tsc): __dirname = dist/src/core/ → need to go to project root then src/tools/skills/
 * In packaged Electron: daemon.mjs runs from resources/daemon/, skills at resources/daemon/skills/
 */
export function resolveSkillsSourceDir(): string {
  // Dev mode: __dirname is src/core/, skills are at src/tools/skills/
  const devCandidate = path.join(__dirname, '..', 'tools', 'skills');
  if (isBuiltinSkillsDir(devCandidate)) return devCandidate;

  // Packaged Electron: daemon.mjs is at resources/daemon/daemon.mjs
  // but __dirname resolves to resources/daemon/ (the script's directory).
  // Skills are copied to resources/daemon/skills/ by prepare-resources.mjs.
  const packagedCandidate = path.join(__dirname, 'skills');
  if (isBuiltinSkillsDir(packagedCandidate)) return packagedCandidate;

  // Prod mode (tsc): __dirname is dist/src/core/, skills source is at ../../src/tools/skills/
  // (go up from dist/src/core → dist/src → dist → project root → src/tools/skills)
  const prodCandidate = path.join(__dirname, '..', '..', '..', 'src', 'tools', 'skills');
  if (isBuiltinSkillsDir(prodCandidate)) return prodCandidate;

  return devCandidate;
}

/**
 * Built-in skills that have been superseded and should be removed from
 * existing vaults on upgrade. The AI will otherwise see multiple overlapping
 * skills (e.g. old pdf + new docling) and pick randomly — usually the worse one.
 *
 * Removed skills are only deleted if they were Molio-installed (i.e. we know
 * their original contents). User-created skills with the same name in other
 * directories are unaffected.
 */
export const DEPRECATED_SKILLS = [
  // v1.1.0: docling replaces the old docx/pdf/pptx/xlsx skills. docling handles
  // all office formats with GPU-accelerated OCR + layout + tables, producing much
  // higher quality markdown than the old skills (which taught the agent to
  // use pypdf/pdfplumber/markitdown — weak on tables, formulas, multi-column).
  'docx',
  'pdf',
  'pptx',
  'xlsx',
];

/**
 * Sentinel used to detect whether the docling-preference rule has already been
 * injected into a vault's .claude/CLAUDE.md. Keeps the injection idempotent.
 */
const DOCLING_RULE_SENTINEL = '<!-- molio:docling-preference -->';

/**
 * Hard rule injected into every vault's .claude/CLAUDE.md to force the agent
 * to prefer the `docling` skill over any globally-installed legacy office skills
 * (docx/pdf/pptx/xlsx/paddleocr*). CLAUDE.md is loaded as system prompt, so it
 * overrides skill-description-based selection — without this, a user who has
 * the old `docx` skill installed globally would have the agent pick it over
 * docling (the old skill's name matches the .docx extension more directly).
 */
const DOCLING_RULE_BLOCK = [
  DOCLING_RULE_SENTINEL,
  '## Document & Video Processing — Always Use `docling`',
  '',
  '**Always use the `docling` skill** for documents (PDF, Office, images) and videos (MP4, MOV, etc.).',
  'If docling encounters errors, retry with different parameters before falling back to other tools.',
].join('\n');

/**
 * Sentinel for the environment self-healing rule.
 */
const ENV_SELF_HEAL_SENTINEL = '<!-- molio:env-self-heal -->';

/**
 * Cross-platform, language-agnostic rule that makes the agent install missing
 * runtimes itself instead of bailing out and asking the user to do manual work.
 *
 * Motivation: a user reported that when `node` was unavailable, the agent told
 * them "Node.js is not available, please paste the article text manually"
 * instead of just installing Node. Molio runs Claude Code with
 * `--dangerously-skip-permissions`, so the agent CAN run install commands — it
 * just needs to be told to do so.
 *
 * Deliberately short: how to detect the platform and which package manager to
 * use is general knowledge the agent already has. This rule only encodes the
 * *behavioral default* (install first, ask last) that the agent would not
 * otherwise infer.
 */
const ENV_SELF_HEAL_BLOCK = [
  ENV_SELF_HEAL_SENTINEL,
  '## Environment Self-healing',
  '',
  'When a CLI tool or runtime required by a skill is missing (`node`, `python`, `pip`, `docling`,',
  '`pandoc`, etc.), **install it automatically before asking the user to do anything manually**.',
  'Molio runs with `--dangerously-skip-permissions`, so install commands are allowed.',
  '',
  'Never tell the user "X is not available, please do it manually" without first attempting to',
  'install it. Bailing out to a manual workaround is the last resort, not the first response.',
  'Only if installation genuinely fails, tell the user what you tried and suggest a fallback.',
  '',
  '**Always use domestic mirrors** when installing packages (pip, npm, conda, go, cargo, etc.).',
  'Most users are in China — default international sources are slow or unreachable.',
  '',
  '## Long-running Task Feedback',
  '',
  'If any task (installation, download, processing, conversion, etc.) is expected to take more',
  'than 5 minutes, proactively inform the user that the task is still in progress so they do',
  'not think the system is stuck or unresponsive.',
].join('\n');

/**
 * Sentinel for the web-fetch preference rule.
 */
const WEB_FETCH_SENTINEL = '<!-- molio:web-fetch-preference -->';

/**
 * Rule that tells the agent to prefer curl over WebFetch for Chinese users.
 * WebFetch runs on Anthropic's overseas servers and often fails on Chinese
 * sites due to anti-scraping and network policies. curl is always available.
 */
const WEB_FETCH_BLOCK = [
  WEB_FETCH_SENTINEL,
  '## Web Fetching — Prefer curl',
  '',
  'WebFetch runs on overseas servers and often fails on Chinese sites.',
  'Prefer `curl` for web content extraction. Only fall back to WebFetch for international sites.',
].join('\n');

/**
 * Sentinel for the remotion video-creation preference rule.
 */
const REMOTION_RULE_SENTINEL = '<!-- molio:remotion-preference -->';

/**
 * Rule that forces the agent to use the `remotion` skill for video creation
 * instead of reaching for moviepy/manim/Python video libraries. Without this,
 * the agent defaults to "I'll stitch frames with Python" even though the
 * remotion skill is installed — the skill description alone is not enough to
 * override the agent's general-knowledge default (the same reason docling
 * needs a hard rule to win over legacy office skills). CLAUDE.md is loaded as
 * system prompt, so it overrides skill-description-based selection.
 *
 * Kept short on purpose: the agent already knows how to make videos; this rule
 * only encodes the behavioral default (use remotion, not Python video libs).
 */
const REMOTION_RULE_BLOCK = [
  REMOTION_RULE_SENTINEL,
  '## Video Creation — Always Use `remotion`',
  '',
  'When the user wants to make/create a video (介绍视频/宣传视频/产品视频/动画/motion graphic/intro/trailer/explainer),',
  '**use the `remotion` skill** — do NOT reach for `moviepy`, `manim`, or Python video libraries.',
  'This applies even when the source is wiki notes, articles, or scripts rather than code.',
].join('\n');

/**
 * Sentinel for the knowledge-base-first retrieval rule.
 */
const WIKI_QUERY_RULE_SENTINEL = '<!-- molio:wiki-query-preference -->';

/**
 * Always-on rule that makes the agent retrieve from the vault's wiki BEFORE
 * any vault-topic work, instead of working from training memory.
 *
 * This replaces the old WIKI_QUERY_PROMPT system-prompt injection, which rode
 * `--append-system-prompt-file` — a flag the CLI silently drops in some
 * environments (verified: the appended frame never reached the model, so vault
 * Q&A was answered purely from memory, ignoring the built wiki). CLAUDE.md is
 * loaded natively by the CLI and reliably reaches the model (same channel as
 * the docling/remotion rules above), so the retrieval instruction actually lands.
 *
 * Deliberately ONLY a trigger policy (when to retrieve + that reading the cheap
 * root index IS the relevance check + the exemption list). The HOW (drill-down
 * flow, citations, grounding creation in vault material) lives in the wiki-query
 * skill — duplicating it here is what made earlier revisions bloat to ~25 lines.
 * Failure modes this wording guards, both real incidents: (1) Q&A-only framing
 * with "writing" exempted let vault-topic creation skip retrieval — fixed by
 * making the trigger form-agnostic (subject decides, not task type); (2) an
 * a-priori "does the vault cover this?" gate forced a memory-based guess before
 * any lookup — fixed by making the cheap index read the check itself.
 */
const WIKI_QUERY_RULE_BLOCK = [
  WIKI_QUERY_RULE_SENTINEL,
  '## 知识库优先',
  '',
  '本库有一套整理好的 wiki —— Molio 的价值在于基于它工作，而不是凭训练记忆。',
  '',
  '**任何与本库内容不是明显无关的任务——无论形式（问答、写作、分析、咨询或其他任何形式）——先调用',
  '`wiki-query` skill。** 凭记忆无法知道本库是否覆盖某主题；读 `wiki/hot.md` + 根 `wiki/INDEX.md`',
  '本身就是判断方式，成本不过几十行。具体如何往下做（深入目录索引、基于库内材料产出、引用标注），',
  'skill 里有完整流程。',
  '',
  '仅当任务与本库内容明显无关时跳过：天气、一般闲聊、纯机械活（代码语法、排版），以及工作区近期',
  '活动/状态（"总结今天的工作"、"最近改了什么"——用 git log / 文件 mtime）。',
].join('\n');

/**
 * All Molio-managed rule blocks injected into every vault's .claude/CLAUDE.md.
 * Each has a unique sentinel so injection is idempotent and individual rules
 * can be revised later without re-injecting stale copies.
 *
 * `gateSlug` ties a rule to a bundled skill: the rule is present only while that
 * skill is effective in the vault, and removed (by sentinel) when it's toggled
 * off. Rules without a gate (env-self-heal, web-fetch) are always on.
 */
const MOILIO_RULES: Array<{ sentinel: string; block: string; label: string; gateSlug?: string }> = [
  { sentinel: DOCLING_RULE_SENTINEL, block: DOCLING_RULE_BLOCK, label: 'docling preference', gateSlug: 'docling' },
  { sentinel: ENV_SELF_HEAL_SENTINEL, block: ENV_SELF_HEAL_BLOCK, label: 'environment self-heal' },
  { sentinel: REMOTION_RULE_SENTINEL, block: REMOTION_RULE_BLOCK, label: 'remotion preference', gateSlug: 'remotion' },
  { sentinel: WEB_FETCH_SENTINEL, block: WEB_FETCH_BLOCK, label: 'web fetch preference' },
  { sentinel: WIKI_QUERY_RULE_SENTINEL, block: WIKI_QUERY_RULE_BLOCK, label: 'wiki-query preference', gateSlug: 'wiki-query' },
];

/**
 * Find the extent of a rule's block: from its sentinel to the start of the
 * nearest OTHER sentinel after it (or end of string). Returns [start, end).
 */
function ruleBlockExtent(content: string, sentinel: string): [number, number] | null {
  const start = content.indexOf(sentinel);
  if (start < 0) return null;
  const afterSentinel = content.slice(start + sentinel.length);
  let end = content.length;
  for (const other of MOILIO_RULES) {
    if (other.sentinel === sentinel) continue;
    const idx = afterSentinel.indexOf(other.sentinel);
    if (idx >= 0 && start + sentinel.length + idx < end) {
      end = start + sentinel.length + idx;
    }
  }
  return [start, end];
}

/**
 * Ensure the vault's .claude/CLAUDE.md reflects the effective set of Molio rule
 * blocks. Each rule is identified by a sentinel comment.
 *
 * - A rule is ACTIVE when it has no gate, or its `gateSlug` is in
 *   `effectiveBundledSlugs`. (Passing no set treats every rule as active — the
 *   pre-per-vault behavior.)
 * - Active + sentinel present → block REPLACED in place (revise across versions).
 * - Active + sentinel absent → block APPENDED.
 * - Inactive + sentinel present → block REMOVED (skill toggled off in this vault).
 * - User content before the first Molio sentinel is never touched.
 *
 * Caveat: a block's extent runs from its sentinel to the NEXT sentinel (or EOF
 * for the last block), so anything written BETWEEN or AFTER Molio blocks is
 * treated as part of the preceding block and replaced/removed with it. Custom
 * content belongs before the first Molio sentinel.
 */
export function ensureMolioRules(claudeDir: string, effectiveBundledSlugs?: Set<string>): void {
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');

  try {
    let content = '';
    let existed = false;
    if (fs.existsSync(claudeMd)) {
      content = fs.readFileSync(claudeMd, 'utf-8');
      existed = true;
    }

    let changed = false;
    const isActive = (rule: { gateSlug?: string }): boolean =>
      !rule.gateSlug || (effectiveBundledSlugs?.has(rule.gateSlug) ?? true);

    // Each pass re-searches `content`, so operating rule-by-rule in array order
    // is safe regardless of appends/removals shifting positions.
    for (const rule of MOILIO_RULES) {
      const extent = ruleBlockExtent(content, rule.sentinel);

      if (!isActive(rule)) {
        if (extent) {
          content = content.slice(0, extent[0]) + content.slice(extent[1]);
          changed = true;
        }
        continue;
      }

      if (extent) {
        const oldBlock = content.slice(extent[0], extent[1]).trimEnd();
        if (oldBlock === rule.block) continue; // already up to date
        content = content.slice(0, extent[0]) + rule.block + '\n' + content.slice(extent[1]);
        changed = true;
      } else {
        content = content.trimEnd()
          ? `${content.trimEnd()}\n\n${rule.block}\n`
          : `${rule.block}\n`;
        changed = true;
      }
    }

    if (!changed) return;

    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(claudeMd, content, 'utf-8');
    console.log(
      `[skill-installer] ${existed ? 'Updated' : 'Created'} .claude/CLAUDE.md with Molio rules`,
    );
  } catch (err) {
    console.error(
      `[skill-installer] Failed to inject Molio rules:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export interface BundledSyncOpts {
  /** Injectable source dir for tests; defaults to resolveSkillsSourceDir(). */
  sourceDir?: string;
}

/**
 * Reconcile a vault's `<vault>/.claude/skills/` for the DB-registered bundled
 * skills, driven entirely by the effective/managed sets computed from the
 * `skills` table (vault-config.ts):
 *
 *  1. install/update every EFFECTIVE bundled slug (whole directory — these
 *     skills are multi-file and SKILL.md depends on its siblings);
 *  2. remove every MANAGED-but-not-effective slug's directory (a bundled skill
 *     toggled off, globally or for this vault). Removal is guarded by a SKILL.md
 *     check so an unmanaged/user directory of the same name is never touched;
 *  3. clean up deprecated skills from previous Molio versions (unconditional);
 *  4. converge the .claude/CLAUDE.md rule blocks to the effective set.
 *
 * `managedSlugs` is the universe of bundled slugs the DB knows about; removal
 * only ever applies within it. A directory whose slug is NOT in `managedSlugs`
 * (e.g. a user's own `wiki-query`, or a bundled skill not yet seeded in a test
 * DB) is left strictly alone — this is the red line vault-config.test.ts guards.
 */
export function reconcileBundledSync(
  effectiveSlugs: Set<string>,
  managedSlugs: Set<string>,
  vaultPath: string,
  opts?: BundledSyncOpts,
): void {
  const sourceDir = opts?.sourceDir ?? resolveSkillsSourceDir();
  const claudeSkillsDir = path.join(vaultPath, '.claude', 'skills');
  const sourceExists = fs.existsSync(sourceDir);
  if (!sourceExists) {
    skillWarn.warn(`source-dir:${sourceDir}`, `[skill-installer] Skills source directory not found: ${sourceDir}`);
  }

  // --- Step 1: remove deprecated skills from previous Molio versions -------
  if (fs.existsSync(claudeSkillsDir)) {
    for (const skillName of DEPRECATED_SKILLS) {
      const skillDest = path.join(claudeSkillsDir, skillName);
      if (!fs.existsSync(skillDest)) continue;

      // Only remove if it looks like a Molio-installed skill (has our SKILL.md).
      // Skip if the user has replaced it with their own version — we never
      // want to delete user content.
      const skillMd = path.join(skillDest, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        console.warn(
          `[skill-installer] Skipping removal of "${skillName}": no SKILL.md (possibly user-created)`,
        );
        continue;
      }

      try {
        fs.rmSync(skillDest, { recursive: true, force: true });
        console.log(`[skill-installer] Removed deprecated skill "${skillName}"`);
      } catch (err) {
        console.error(
          `[skill-installer] Failed to remove deprecated skill "${skillName}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // --- Step 2: install/update effective bundled skills ---------------------
  if (sourceExists) {
    for (const skillName of effectiveSlugs) {
      const skillSrc = path.join(sourceDir, skillName);
      const skillDest = path.join(claudeSkillsDir, skillName);

      if (!fs.existsSync(skillSrc)) {
        skillWarn.warn(`skill-src:${skillSrc}`, `[skill-installer] Skill source not found: ${skillSrc}`);
        continue;
      }

      try {
        // Content-hash mirror (dirsync): installs when missing, updates on any
        // drift (version bump, edited/corrupted dest), no-op when already in
        // sync — same convergence guarantees as library/core skill sync.
        if (mirrorDirIfChanged(skillSrc, skillDest)) {
          console.log(`[skill-installer] Installed/updated skill "${skillName}" → ${skillDest}`);
        }
      } catch (err) {
        console.error(
          `[skill-installer] Failed to install skill "${skillName}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // --- Step 3: remove managed bundled skills that are no longer effective --
  for (const skillName of managedSlugs) {
    if (effectiveSlugs.has(skillName)) continue;
    const skillDest = path.join(claudeSkillsDir, skillName);
    if (!fs.existsSync(skillDest)) continue;
    // Guard: only remove dirs that look Molio-installed (have a SKILL.md), so a
    // user's own same-named directory is never deleted.
    if (!fs.existsSync(path.join(skillDest, 'SKILL.md'))) continue;
    try {
      fs.rmSync(skillDest, { recursive: true, force: true });
      console.log(`[skill-installer] Removed disabled skill "${skillName}"`);
    } catch (err) {
      console.error(
        `[skill-installer] Failed to remove disabled skill "${skillName}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // --- Step 4: converge .claude/CLAUDE.md rule blocks to the effective set --
  ensureMolioRules(path.join(vaultPath, '.claude'), effectiveSlugs);
}
