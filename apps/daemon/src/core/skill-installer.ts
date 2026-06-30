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
  // (构建/入库/健康检查/归档). Replaces the old wikiOperation prompt-prepend
  // path so chat-typed verbs and UI buttons hit the same procedure.
  'wiki-build',
  'wiki-ingest',
  'wiki-lint',
  'wiki-save',
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
function copyDirSync(src: string, dest: string): void {
  if (fs.existsSync(dest)) return; // idempotent: skip if already installed

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
  '## Document Processing — Always Use `docling`',
  '',
  'When processing office documents (`.pdf`, `.docx`, `.pptx`, `.xlsx`, `.doc`, `.ppt`, `.xls`)',
  'or images containing text, **always use the `docling` skill**. Do NOT use the `docx`, `pdf`,',
  '`pptx`, `xlsx`, or `paddleocr*` skills even if they are available — docling produces',
  'higher-quality Markdown (GPU-accelerated OCR + layout detection + table structure).',
  'Only fall back to other tools if docling fails or is not installed.',
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
 * All Molio-managed rule blocks injected into every vault's .claude/CLAUDE.md.
 * Each has a unique sentinel so injection is idempotent and individual rules
 * can be revised later without re-injecting stale copies.
 */
const MOILIO_RULES: Array<{ sentinel: string; block: string; label: string }> = [
  { sentinel: DOCLING_RULE_SENTINEL, block: DOCLING_RULE_BLOCK, label: 'docling preference' },
  { sentinel: ENV_SELF_HEAL_SENTINEL, block: ENV_SELF_HEAL_BLOCK, label: 'environment self-heal' },
  { sentinel: WEB_FETCH_SENTINEL, block: WEB_FETCH_BLOCK, label: 'web fetch preference' },
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
      copyDirSync(skillSrc, skillDest);
      console.log(`[skill-installer] Installed skill "${skillName}" → ${skillDest}`);
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
