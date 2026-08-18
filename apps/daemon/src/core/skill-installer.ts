/**
 * Install built-in Molio skills into a vault's .claude/skills/ directory.
 * Called during vault creation / import so that runtime CLIs (Claude Code, etc.)
 * automatically discover the skills on startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThrottledWarn } from './throttled-warn.js';
import { isAlreadySynced, mirrorDirIfChanged } from './skills/dirsync.js';

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
  // NOTE: remotion used to be bundled here. It was retired (see
  // RETIRED_BUNDLED_SKILLS): users who want video creation install the
  // third-party `am-will/remotion` skill from the skill hub instead — a
  // regular toggleable/deletable library skill, no app-owned preload.
];

/**
 * Bundled skills that Molio no longer ships but that may still exist in
 * vaults synced by older versions. They are listed here (in addition to being
 * deleted from the `skills` table on startup — see builtin.ts) so
 * reconcileVault can include them in the MANAGED set passed to
 * reconcileBundledSync: step 3 then removes the stale `<vault>/.claude/skills/<slug>/`
 * copy — but only with the usual byte-for-byte ownership proof, which is why
 * the shipped source directory (`tools/skills/<slug>/`) is deliberately KEPT
 * in the app resources even though nothing installs from it anymore.
 */
export const RETIRED_BUNDLED_SKILLS = [
  // Video creation moved to the skill hub's `am-will/remotion` (installed as a
  // normal library skill on demand). The bundled Molio-customized variant (CN
  // browser preflight, trigger-word rule) is no longer maintained in-app, and
  // its npm-dependency preload was removed along with it — first use installs
  // deps on the spot (the hub skill's own preflight covers that).
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
 * RETIRED: the remotion skill is no longer bundled (see RETIRED_BUNDLED_SKILLS),
 * so this rule's gateSlug ('remotion') is never in any vault's effective set and
 * ensureMolioRules REMOVES the block (by sentinel) from every vault it
 * reconciles. The entry + exact block text are deliberately KEPT: removal of
 * legacy single-sentinel blocks compares against rule.block, and deleting the
 * entry would both leave stale rules in user vaults forever and force the
 * unknowable-extent fallback that can eat user content after the block.
 *
 * Original purpose (for context): force the agent to use the `remotion` skill
 * for video creation instead of moviepy/manim/Python video libraries — the
 * skill description alone doesn't override the agent's general-knowledge
 * default (same reason docling needs a hard rule over legacy office skills).
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
 * the docling rule above), so the retrieval instruction actually lands.
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
  // Retired — gateSlug never effective anymore; the entry survives only so the
  // block is removed (by sentinel) from vaults that still carry it. See the
  // REMOTION_RULE_BLOCK comment.
  { sentinel: REMOTION_RULE_SENTINEL, block: REMOTION_RULE_BLOCK, label: 'remotion preference (retired)', gateSlug: 'remotion' },
  { sentinel: WEB_FETCH_SENTINEL, block: WEB_FETCH_BLOCK, label: 'web fetch preference' },
  { sentinel: WIKI_QUERY_RULE_SENTINEL, block: WIKI_QUERY_RULE_BLOCK, label: 'wiki-query preference', gateSlug: 'wiki-query' },
];

/** Closing sentinel of a rule block: `<!-- molio:x -->` → `<!-- /molio:x -->`. */
function endSentinelOf(sentinel: string): string {
  return sentinel.replace(/^<!--\s*/, '<!-- /');
}

/** The full wrapped block text as written into CLAUDE.md (BEGIN…body…END). */
function wrapRule(rule: { sentinel: string; block: string }): string {
  return `${rule.block}\n${endSentinelOf(rule.sentinel)}`;
}

/** Index of the nearest OTHER rule's sentinel at/after `from`, or -1. */
function nextOtherSentinelIndex(content: string, sentinel: string, from: number): number {
  let next = -1;
  for (const other of MOILIO_RULES) {
    if (other.sentinel === sentinel) continue;
    const idx = content.indexOf(other.sentinel, from);
    if (idx >= 0 && (next < 0 || idx < next)) next = idx;
  }
  return next;
}

interface RuleExtent {
  /** Start of the sentinel's line. */
  start: number;
  /** Exclusive end (includes the END sentinel line's trailing newline). */
  end: number;
  /** True when the block carries the new BEGIN/END wrapping. */
  wrapped: boolean;
}

/**
 * Locate a rule's block in `content`.
 *
 * New format: BEGIN sentinel … END sentinel (`<!-- /molio:x -->`) — the extent
 * is exactly those lines, so removal/replacement can never touch content the
 * user wrote after the block.
 *
 * Legacy format (single sentinel, written by pre-dual-sentinel builds): the
 * extent runs from the sentinel to the start of the nearest OTHER sentinel (or
 * EOF). Callers use that knowledge to migrate conservatively (see
 * ensureMolioRules) instead of blindly re-applying the old semantics.
 */
function findRuleExtent(content: string, sentinel: string): RuleExtent | null {
  const startIdx = content.indexOf(sentinel);
  if (startIdx < 0) return null;
  const start = content.lastIndexOf('\n', startIdx) + 1; // 0 when on first line
  const afterBegin = startIdx + sentinel.length;

  const endIdx = content.indexOf(endSentinelOf(sentinel), afterBegin);
  const nextBegin = nextOtherSentinelIndex(content, sentinel, afterBegin);
  if (endIdx >= 0 && (nextBegin < 0 || endIdx < nextBegin)) {
    const lineEnd = content.indexOf('\n', endIdx);
    return { start, end: lineEnd < 0 ? content.length : lineEnd + 1, wrapped: true };
  }

  // Legacy: sentinel → nearest other sentinel (or EOF).
  return { start, end: nextBegin < 0 ? content.length : nextBegin, wrapped: false };
}

/**
 * Ensure the vault's .claude/CLAUDE.md reflects the effective set of Molio rule
 * blocks. Each rule is wrapped in BEGIN/END sentinel comments:
 *
 *     <!-- molio:x-preference -->        ← BEGIN (the rule.sentinel)
 *     ## …rule body…
 *     <!-- /molio:x-preference -->       ← END
 *
 * - A rule is ACTIVE when it has no gate, or its `gateSlug` is in
 *   `effectiveBundledSlugs`. (Passing no set treats every rule as active — the
 *   pre-per-vault behavior.)
 * - Active + block present → block REPLACED in place (revise across versions).
 * - Active + block absent → block APPENDED.
 * - Inactive + block present → block REMOVED (skill toggled off in this vault).
 *
 * Because removal/replacement operate on the exact BEGIN..END extent, content
 * the user wrote AFTER (or between) blocks is never touched — the old
 * sentinel-to-next-sentinel extent silently deleted whatever followed the last
 * block when a gated rule (e.g. wiki-query) was toggled off.
 *
 * LEGACY MIGRATION: blocks written by pre-dual-sentinel builds carry only the
 * BEGIN sentinel; their extent is unknowable in general (it used to run to the
 * next sentinel / EOF). Migration is conservative:
 *  - stored text equals/starts with the CURRENT rule.block → the boundary is
 *    provable: wrap the block and KEEP everything after it;
 *  - anything else (older revision, unknown additions) → replace/remove the
 *    whole legacy extent, i.e. exactly the pre-migration behavior, one last
 *    time. Either way the file converges to the wrapped format, after which
 *    user content anywhere is safe.
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
      const extent = findRuleExtent(content, rule.sentinel);
      const wrapped = wrapRule(rule);
      const replacement = `${wrapped}\n`;

      if (!isActive(rule)) {
        if (!extent) continue;
        const rangeText = content.slice(extent.start, extent.end);
        if (extent.wrapped || rangeText.trimEnd() === rule.block) {
          // Precise removal: wrapped extent is exact; an unambiguous legacy
          // block (identical to the current one) covers exactly its extent.
          content = content.slice(0, extent.start) + content.slice(extent.end);
          changed = true;
        } else if (rangeText.startsWith(rule.block)) {
          // Unrevised legacy block with trailing content (typically user text
          // appended after the LAST block): strip only the block's own lines —
          // the old extent removal would have deleted the trailing content too.
          let prefixEnd = extent.start + rule.block.length;
          while (content[prefixEnd] === '\n' || content[prefixEnd] === '\r') prefixEnd++;
          content = content.slice(0, extent.start) + content.slice(prefixEnd);
          changed = true;
        } else {
          // Revised legacy block — boundary between old block text and any
          // extras is unknowable; fall back to the legacy extent removal.
          content = content.slice(0, extent.start) + content.slice(extent.end);
          changed = true;
        }
        continue;
      }

      if (!extent) {
        content = content.trimEnd()
          ? `${content.trimEnd()}\n\n${replacement}`
          : replacement;
        changed = true;
        continue;
      }

      const oldText = content.slice(extent.start, extent.end);
      if (extent.wrapped) {
        if (oldText.trimEnd() === wrapped) continue; // already up to date
        content = content.slice(0, extent.start) + replacement + content.slice(extent.end);
        changed = true;
        continue;
      }

      // Legacy block, rule active: migrate into the wrapped format.
      if (oldText.trimEnd() === rule.block) {
        // Clean: stored block equals the current revision, nothing extra.
        content = content.slice(0, extent.start) + replacement + content.slice(extent.end);
        changed = true;
      } else if (oldText.startsWith(rule.block)) {
        // Unrevised block + trailing content: wrap the block, KEEP the rest
        // (the old replace-the-extent path would have silently deleted it).
        const rest = oldText.slice(rule.block.length).replace(/^[\r\n]+/, '');
        content = content.slice(0, extent.start) + (rest ? `${wrapped}\n\n${rest}` : replacement) + content.slice(extent.end);
        changed = true;
      } else {
        // Drift (older revision ± unknown additions): boundary unknowable —
        // replace the whole legacy extent, as the pre-migration code did.
        content = content.slice(0, extent.start) + replacement + content.slice(extent.end);
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
 *     toggled off, globally or for this vault). Removal demands OWNERSHIP
 *     PROOF — the dir must byte-for-byte mirror Molio's own source for that
 *     slug — so a user's own same-named skill (which always has a SKILL.md of
 *     its own) is never deleted;
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
        // sync — same convergence guarantees as library skill sync.
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
    // Ownership PROOF, not guesswork: the old "has a SKILL.md" guard was
    // inverted — a user's own same-named skill ALWAYS has a SKILL.md, so it
    // would be rm -rf'd the moment the bundled skill toggled off. Only delete
    // when the dir byte-for-byte mirrors Molio's source for this slug (which a
    // user-authored skill cannot). Without a readable source we cannot prove
    // ownership → skip deletion and let the dir stay.
    const skillSrc = path.join(sourceDir, skillName);
    if (!sourceExists || !fs.existsSync(skillSrc) || !isAlreadySynced(skillSrc, skillDest)) {
      continue;
    }
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
