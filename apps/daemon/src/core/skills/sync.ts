/**
 * Library/core skill sync — mirror enabled skills from the Molio library
 * (`~/.molio/skills/`) into the skills dir the runtime CLIs actually read.
 *
 * Which dir that is decided by the caller via `claudeHome`: vault-config.ts
 * points it at each registered vault's `<vault>/.claude`, so every vault gets
 * its own copy; cleanupLegacyGlobalSync uses the default (`~/.claude`) to sweep
 * out leftovers of the pre-per-vault global sync.
 *
 * Safety red line: we ONLY ever create/modify/delete directories whose name
 * starts with `molio--`. The user's own skills are never touched —
 * reconcileSync removes only orphaned `molio--*` dirs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MOLIO_PREFIX,
  claudeSkillsDir,
  molioSkillDir,
  skillContentDir,
  type SkillPathsOpts,
} from './paths.js';
import { mirrorDirIfChanged } from './dirsync.js';

/**
 * Mirror the library skill's whole content dir into its namespaced
 * `molio--<id>/` dir. A single-file skill copies just its SKILL.md; a
 * multi-file (imported) skill copies SKILL.md + every sibling so
 * references/scripts the SKILL.md points at actually reach the runtime.
 * Staleness detection + atomic rebuild live in dirsync.mirrorDirIfChanged.
 */
export function syncSkill(id: string, opts?: SkillPathsOpts): void {
  const srcDir = skillContentDir(id, opts);
  if (!fs.existsSync(srcDir)) return; // nothing to sync
  mirrorDirIfChanged(srcDir, molioSkillDir(id, opts));
}

/**
 * Reconcile the target skills dir with the set of enabled skill ids:
 *  1. ensure every enabled id has its `molio--<id>/SKILL.md` present;
 *  2. remove any `molio--*` dir whose id is NOT enabled (orphan cleanup).
 * Non-`molio--` directories are left strictly untouched.
 */
export function reconcileSync(enabledIds: string[], opts?: SkillPathsOpts): void {
  for (const id of enabledIds) {
    try {
      syncSkill(id, opts);
    } catch (err) {
      console.error(`[skills] Failed to sync skill "${id}":`, err instanceof Error ? err.message : err);
    }
  }

  const dir = claudeSkillsDir(opts);
  if (!fs.existsSync(dir)) return;

  const enabledSet = new Set(enabledIds);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(MOLIO_PREFIX)) continue; // never touch user skills
    const id = entry.name.slice(MOLIO_PREFIX.length);
    if (!enabledSet.has(id)) {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }
}
