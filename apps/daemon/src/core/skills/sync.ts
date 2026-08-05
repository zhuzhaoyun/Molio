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
 * reconcileSync removes only orphaned `molio--*` dirs. Ownership contract:
 * the `molio--` prefix itself is Molio's namespace claim; anything bearing it
 * inside a managed skills dir is treated as Molio-managed by definition, so
 * users must not create their own `molio--*` directories there.
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
import { mirrorDirIfChanged, sweepStaleMirrorArtifacts, isMirrorArtifactName } from './dirsync.js';

/**
 * Mirror the library skill's whole content dir into its namespaced
 * `molio--<id>/` dir. A single-file skill copies just its SKILL.md; a
 * multi-file (imported) skill copies SKILL.md + every sibling so
 * references/scripts the SKILL.md points at actually reach the runtime.
 * Staleness detection + atomic rebuild live in dirsync.mirrorDirIfChanged.
 */
export function syncSkill(id: string, opts?: SkillPathsOpts): void {
  const srcDir = skillContentDir(id, opts);
  if (!fs.existsSync(srcDir)) {
    // Source vanished (manual deletion, disk cleanup, corrupted home) while
    // the DB row lives on: remove the stale mirror too. The id is still in
    // enabledIds, so the orphan cleanup below would SKIP it — without this the
    // outdated copy stays in every vault and runtime CLIs load it forever.
    fs.rmSync(molioSkillDir(id, opts), { recursive: true, force: true });
    return;
  }
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

  // Remove staging dirs a killed daemon left inside the scanned skills dir
  // (best-effort, age-guarded; see dirsync.sweepStaleMirrorArtifacts).
  sweepStaleMirrorArtifacts(dir);

  // Orphan cleanup — fully tolerant: this runs against NAS-mounted vaults
  // where any single fs call can hit EACCES/EBUSY, and it is also called from
  // cleanupLegacyGlobalSync WITHOUT an outer try/catch. One locked entry must
  // degrade to a warning, never abort the rest of the reconciliation.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn('[skills] Orphan cleanup scan failed:', err instanceof Error ? err.message : err);
    return;
  }
  const enabledSet = new Set(enabledIds);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(MOLIO_PREFIX)) continue; // never touch user skills
    // Staging artifacts (`molio--<id>.tmp/bak-…`) belong to the sweep's
    // age-guarded domain: an in-flight mirror of a FRESH artifact would be
    // rm -rf'd under the other process if the orphan scan claimed it here.
    if (isMirrorArtifactName(entry.name)) continue;
    const id = entry.name.slice(MOLIO_PREFIX.length);
    if (!enabledSet.has(id)) {
      try {
        fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[skills] Failed to remove orphan skill dir "${entry.name}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
