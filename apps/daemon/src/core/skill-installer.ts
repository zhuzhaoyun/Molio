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
const BUILTIN_SKILLS = ['wechat-article-extractor', 'docx', 'pdf', 'pptx', 'xlsx'];

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
 * Install all built-in Molio skills into the given vault path.
 * Safe to call multiple times — existing skills are skipped.
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
}
