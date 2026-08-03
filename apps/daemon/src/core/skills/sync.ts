/**
 * Sync enabled skills from the Molio library (`~/.molio/skills/`) into the place
 * Claude Code actually reads (`~/.claude/skills/molio--<id>/`).
 *
 * Safety red line: we ONLY ever create/modify/delete directories whose name
 * starts with `molio--`. The user's own skills in `~/.claude/skills/` are never
 * touched. reconcileSync removes only orphaned `molio--*` dirs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MOLIO_PREFIX,
  claudeSkillsDir,
  molioSkillDir,
  skillContentDir,
  type SkillPathsOpts,
} from './paths.js';
import { copyDirSync } from '../skill-installer.js';

/**
 * Content hash of a directory tree (sorted relative paths + file bytes).
 * Symlinks are skipped here but copied by copyDirSync, so a tree containing
 * them simply never short-circuits (always rebuilds) — never a wrong result.
 */
function hashDir(dir: string): string {
  const hash = crypto.createHash('sha256');
  const walk = (d: string, rel: string): void => {
    const entries = fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`d:${r}\n`);
        walk(p, r);
      } else if (entry.isFile()) {
        hash.update(`f:${r}\n`);
        hash.update(fs.readFileSync(p));
        hash.update('\n');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/** True when `destDir` exists and byte-for-byte mirrors `srcDir`. */
function isAlreadySynced(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(destDir)) return false;
  try {
    return hashDir(srcDir) === hashDir(destDir);
  } catch {
    return false; // unreadable dest → rebuild
  }
}

/**
 * Mirror the library skill's whole content dir into its namespaced
 * `~/.claude/skills/molio--<id>/` dir. A single-file skill copies just its
 * SKILL.md; a multi-file (imported) skill copies SKILL.md + every sibling so
 * references/scripts the SKILL.md points at actually reach the runtime.
 *
 * Two optimizations over a blind rm+copy:
 *  - Short-circuit: when dest already mirrors src (content hash match) nothing
 *    is written. Startup fans out to every vault on each boot, so this keeps
 *    the steady state read-only — especially important on NAS-mounted vaults.
 *    Dest pollution (extra/missing files) breaks the hash match → rebuild, so
 *    convergence is preserved.
 *  - Atomic swap: the rebuild copies into a temp dir first, then renames it
 *    into place, so a concurrent agent CLI never reads a half-copied skill dir.
 */
export function syncSkill(id: string, opts?: SkillPathsOpts): void {
  const srcDir = skillContentDir(id, opts);
  if (!fs.existsSync(srcDir)) return; // nothing to sync
  const dest = molioSkillDir(id, opts);
  if (isAlreadySynced(srcDir, dest)) return;

  const tmp = `${dest}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    copyDirSync(srcDir, tmp);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
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
