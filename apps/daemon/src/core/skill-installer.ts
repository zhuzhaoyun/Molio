/**
 * Install built-in Molio skills into a vault's .claude/skills/ directory.
 * Called during vault creation / import so that runtime CLIs (Claude Code, etc.)
 * automatically discover the skills on startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Built-in skills shipped with Molio. */
const BUILTIN_SKILLS = [
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
 * Resolve the source directory for built-in skills.
 * In dev (tsx): __dirname = src/core/ → ../tools/skills/ exists
 * In prod (tsc): __dirname = dist/src/core/ → need to go to project root then src/tools/skills/
 * In packaged Electron: daemon.mjs runs from resources/daemon/, skills at resources/daemon/skills/
 */
function resolveSkillsSourceDir(): string {
  // Dev mode: __dirname is src/core/, skills are at src/tools/skills/
  const devCandidate = path.join(__dirname, '..', 'tools', 'skills');
  if (fs.existsSync(devCandidate)) return devCandidate;

  // Packaged Electron: daemon.mjs is at resources/daemon/daemon.mjs
  // but __dirname resolves to resources/daemon/ (the script's directory).
  // Skills are copied to resources/daemon/skills/ by prepare-resources.mjs.
  const packagedCandidate = path.join(__dirname, 'skills');
  if (fs.existsSync(packagedCandidate)) return packagedCandidate;

  // Prod mode (tsc): __dirname is dist/src/core/, skills source is at ../../src/tools/skills/
  // (go up from dist/src/core → dist/src → dist → project root → src/tools/skills)
  const prodCandidate = path.join(__dirname, '..', '..', '..', 'src', 'tools', 'skills');
  if (fs.existsSync(prodCandidate)) return prodCandidate;

  return devCandidate;
}

/**
 * Recursively copy a directory, skipping if destination already exists (idempotent).
 */
/**
 * Read the version from a skill's SKILL.md file.
 * Returns null if the file doesn't exist or has no version field.
 */
function readSkillVersion(skillDir: string): string | null {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;

  const content = fs.readFileSync(skillMd, 'utf-8');
  const match = content.match(/^version:\s*(.+)$/m);
  return match && match[1] ? match[1].trim() : null;
}

/**
 * Check if the destination skill is out of date relative to the source.
 *
 * - dest missing → install
 * - source unversioned → can't reason about staleness, skip (leave dest as-is)
 * - dest unversioned but source versioned → dest predates versioning, update
 *   (this is what lets a newly-versioned skill propagate to existing vaults;
 *   without it, a skill that gained a `version:` field later would never reach
 *   vaults that already had an older version-less copy installed)
 * - both versioned → update iff versions differ
 */
function shouldUpdateSkill(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(destDir)) return true; // dest doesn't exist, need to install

  const srcVersion = readSkillVersion(srcDir);
  const destVersion = readSkillVersion(destDir);

  if (!srcVersion) return false; // source unversioned — can't reason, assume up-to-date
  if (!destVersion) return true; // dest predates versioning — update to versioned copy

  return srcVersion !== destVersion;
}

/**
 * Recursively copy a directory, overwriting files to keep them in sync.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
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
const DEPRECATED_SKILLS = [
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
 */
const MOILIO_RULES: Array<{ sentinel: string; block: string; label: string }> = [
  { sentinel: DOCLING_RULE_SENTINEL, block: DOCLING_RULE_BLOCK, label: 'docling preference' },
  { sentinel: ENV_SELF_HEAL_SENTINEL, block: ENV_SELF_HEAL_BLOCK, label: 'environment self-heal' },
  { sentinel: REMOTION_RULE_SENTINEL, block: REMOTION_RULE_BLOCK, label: 'remotion preference' },
  { sentinel: WEB_FETCH_SENTINEL, block: WEB_FETCH_BLOCK, label: 'web fetch preference' },
  { sentinel: WIKI_QUERY_RULE_SENTINEL, block: WIKI_QUERY_RULE_BLOCK, label: 'wiki-query preference' },
];

/**
 * Ensure the vault's .claude/CLAUDE.md contains the latest version of all
 * Molio-managed rule blocks. Each rule is identified by a sentinel comment.
 *
 * - If a rule's sentinel is already present, its block is REPLACED in place
 *   with the current content (so we can revise rules across Molio versions
 *   without leaving stale copies behind).
 * - If a rule's sentinel is absent, the block is APPENDED to the end.
 * - User content before the first Molio sentinel is never touched.
 */
function ensureMolioRules(claudeDir: string): void {
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');

  try {
    let content = '';
    let existed = false;
    if (fs.existsSync(claudeMd)) {
      content = fs.readFileSync(claudeMd, 'utf-8');
      existed = true;
    }

    let changed = false;

    // Process in reverse order so appending later rules doesn't shift the
    // position of earlier sentinels we haven't processed yet.
    for (let i = MOILIO_RULES.length - 1; i >= 0; i--) {
      const rule = MOILIO_RULES[i];
      if (!rule) continue;
      const sentinelIdx = content.indexOf(rule.sentinel);

      if (sentinelIdx >= 0) {
        // Sentinel found — replace the existing block in place.
        // Block runs from the sentinel to the start of the next sentinel
        // (or end of file if this is the last rule).
        const afterSentinel = content.slice(sentinelIdx + rule.sentinel.length);
        let blockEnd = content.length;
        for (const other of MOILIO_RULES) {
          if (other.sentinel === rule.sentinel) continue;
          const otherIdx = afterSentinel.indexOf(other.sentinel);
          if (otherIdx >= 0 && sentinelIdx + rule.sentinel.length + otherIdx < blockEnd) {
            blockEnd = sentinelIdx + rule.sentinel.length + otherIdx;
          }
        }

        // Trim any trailing whitespace from the old block before replacing
        const oldBlock = content.slice(sentinelIdx, blockEnd).trimEnd();
        const newBlock = rule.block;
        if (oldBlock === newBlock) continue; // already up to date

        content = content.slice(0, sentinelIdx) + newBlock + '\n' + content.slice(blockEnd);
        changed = true;
      } else {
        // Sentinel not found — append this rule at the end.
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

/**
 * Install all built-in Molio skills into the given vault path.
 * Safe to call multiple times — existing skills are skipped.
 * Also removes any deprecated skills from previous versions so the agent
 * doesn't see overlapping skill choices.
 *
 * @param vaultPath - Absolute path to the vault root directory
 */
export function installBuiltinSkills(vaultPath: string): void {
  const sourceDir = resolveSkillsSourceDir();

  if (!fs.existsSync(sourceDir)) {
    console.warn(`[skill-installer] Skills source directory not found: ${sourceDir}`);
    return;
  }

  const claudeSkillsDir = path.join(vaultPath, '.claude', 'skills');

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

  // --- Step 2: install current built-in skills -----------------------------
  for (const skillName of BUILTIN_SKILLS) {
    const skillSrc = path.join(sourceDir, skillName);
    const skillDest = path.join(claudeSkillsDir, skillName);

    if (!fs.existsSync(skillSrc)) {
      console.warn(`[skill-installer] Skill source not found: ${skillSrc}`);
      continue;
    }

    try {
      if (shouldUpdateSkill(skillSrc, skillDest)) {
        copyDirSync(skillSrc, skillDest);
        console.log(`[skill-installer] Installed/updated skill "${skillName}" → ${skillDest}`);
      }
    } catch (err) {
      console.error(
        `[skill-installer] Failed to install skill "${skillName}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // --- Step 3: inject Molio rules into .claude/CLAUDE.md -------------------
  // (a) prefer docling over legacy office skills
  // (b) auto-install missing runtimes (node/python/etc.) instead of bailing
  // See ensureMolioRules.
  ensureMolioRules(path.join(vaultPath, '.claude'));
}
