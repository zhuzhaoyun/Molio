/**
 * Sync enabled skills from the Molio library (`~/.molio/skills/`) into the place
 * Claude Code actually reads (`~/.claude/skills/molio--<id>/`).
 *
 * Safety red line: we ONLY ever create/modify/delete directories whose name
 * starts with `molio--`. The user's own skills in `~/.claude/skills/` are never
 * touched. reconcileSync removes only orphaned `molio--*` dirs.
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

/** Write the library skill's SKILL.md into its namespaced `~/.claude/skills/molio--<id>/` dir. */
export function syncSkill(id: string, opts?: SkillPathsOpts): void {
  const srcMd = path.join(skillContentDir(id, opts), 'SKILL.md');
  if (!fs.existsSync(srcMd)) return; // nothing to sync
  const dest = molioSkillDir(id, opts);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(srcMd, path.join(dest, 'SKILL.md'));
}

/** Remove a skill's namespaced dir from `~/.claude/skills/`. Never touches non-molio dirs. */
export function removeSkillSyncDir(id: string, opts?: SkillPathsOpts): void {
  fs.rmSync(molioSkillDir(id, opts), { recursive: true, force: true });
}

/**
 * Reconcile `~/.claude/skills/` with the set of enabled skill ids:
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
