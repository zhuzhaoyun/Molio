/**
 * Library/core skill sync — mirror enabled skills from the Molio library
 * (`~/.molio/skills/`) into the skills dir the runtime CLIs actually read.
 *
 * Which dir that is decided by the caller via `claudeHome`: vault-config.ts
 * points it at each registered vault's `<vault>/.claude`, so every vault gets
 * its own copy; cleanupLegacyGlobalSync uses the default (`~/.claude`) to sweep
 * out leftovers of the pre-per-vault global sync.
 *
 * Dir naming: synced dirs are `molio--<dirName>` where dirName is the skill's
 * slugified DISPLAY name (readable in runtime skill lists, unlike the DB uuid).
 * planSyncTargets plans the names deterministically — earliest skill keeps the
 * plain slug, later same-name arrivals get a stable id-derived suffix — so
 * repeated reconciles never flip-flop the orphan cleanup.
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
  slugifySkillName,
  type SkillPathsOpts,
} from './paths.js';
import { mirrorDirIfChanged, sweepStaleMirrorArtifacts, isMirrorArtifactName } from './dirsync.js';

/** Fields planSyncTargets needs from a skill entry. */
export interface SkillSyncInput {
  id: string;
  name: string;
  createdAt: number;
}

/** One planned mirror: library content keyed by id, vault dir by dirName. */
export interface SyncTarget {
  /** Library content dir key (`~/.molio/skills/<id>`). */
  id: string;
  /** Dir segment after the `molio--` prefix in the synced skills dir. */
  dirName: string;
}

/**
 * Plan each skill's `molio--` dir name from its display name:
 *  - base = slugifySkillName(name); an empty slug (emoji-only names) falls
 *    back to `skill-<id prefix>`;
 *  - same-name collisions get a `-<id prefix>` suffix: deterministic across
 *    reconciles because it derives from the immutable id, NOT a random number
 *    minted at sync time (a random suffix would make the orphan cleanup delete
 *    and rebuild the dir on every reconcile).
 * Assignment order is createdAt ASC (tie-break id), so the EARLIEST skill
 * keeps the plain readable name and later arrivals carry the suffix — stable
 * as the library grows.
 */
export function planSyncTargets(entries: SkillSyncInput[]): SyncTarget[] {
  const sorted = [...entries].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const taken = new Set<string>();
  const targets: SyncTarget[] = [];
  for (const entry of sorted) {
    let dirName = slugifySkillName(entry.name) || `skill-${entry.id.slice(0, 8)}`;
    if (taken.has(dirName)) {
      const suffixed = `${dirName}-${entry.id.slice(0, 8)}`;
      if (!taken.has(suffixed)) {
        dirName = suffixed;
      } else {
        // EVERY form must be checked against `taken`: a crafted/imported
        // display name can slugify to another skill's id-suffixed form, and an
        // unchecked assignment would hand two skills the SAME dirName — they
        // would silently overwrite each other's mirror.
        const fullIdName = `${dirName}-${entry.id}`;
        dirName = taken.has(fullIdName) ? `${fullIdName}-${entry.id.slice(0, 8)}` : fullIdName;
      }
    }
    taken.add(dirName);
    targets.push({ id: entry.id, dirName });
  }
  return targets;
}

/**
 * Mirror the library skill's whole content dir into its planned
 * `molio--<dirName>/` dir (dirName comes from planSyncTargets — the slugified
 * display name, not the id). A single-file skill copies just its SKILL.md; a
 * multi-file (imported) skill copies SKILL.md + every sibling so
 * references/scripts the SKILL.md points at actually reach the runtime.
 * Staleness detection + atomic rebuild live in dirsync.mirrorDirIfChanged.
 */
export function syncSkill(id: string, dirName: string, opts?: SkillPathsOpts): void {
  const srcDir = skillContentDir(id, opts);
  try {
    fs.lstatSync(srcDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Source vanished (manual deletion, disk cleanup, corrupted home) while
      // the DB row lives on: remove the stale mirror too. The target is still
      // in the planned set, so the orphan cleanup below would SKIP it —
      // without this the outdated copy stays in every vault and runtime CLIs
      // load it forever. (existsSync was NOT enough here: it also reports
      // false on EACCES, so a NAS permission blip deleted healthy mirrors.)
      fs.rmSync(molioSkillDir(dirName, opts), { recursive: true, force: true });
      return;
    }
    // Any other error (EACCES/EBUSY/…) means "can't tell", not "gone": keep
    // the last good mirror instead of rm -rf'ing an enabled skill out of the
    // vault on a transient glitch.
    console.warn(
      `[skills] Cannot stat skill source "${srcDir}" (${code}); keeping existing mirror`,
    );
    return;
  }
  mirrorDirIfChanged(srcDir, molioSkillDir(dirName, opts));
}

/**
 * Reconcile the target skills dir with the planned target set:
 *  1. ensure every target has its `molio--<dirName>/SKILL.md` present;
 *  2. remove any `molio--*` dir NOT in the planned set (orphan cleanup).
 * Non-`molio--` directories are left strictly untouched.
 *
 * Orphan cleanup is dirName-based, which makes rename + legacy-layout
 * convergence automatic: a renamed skill's old dir (and any pre-name-based
 * `molio--<uuid>` dir left by older builds) simply stops matching the planned
 * set and is swept on the next reconcile.
 *
 * BUT the sweep only runs on a FULLY SUCCESSFUL pass. A rename changes the
 * planned dirName, so if the NEW dir fails to sync (the NAS EACCES/EBUSY
 * class of errors this module degrades on) while the sweep still runs, the
 * OLD dir is removed as an orphan and the vault is left with NO copy of the
 * skill. Skipping the sweep on a degraded pass trades slower garbage
 * collection for the module's standing rule: a failure degrades to "old
 * content stays", never "skill gone". Convergence resumes on the next clean
 * pass.
 */
export function reconcileSync(targets: SyncTarget[], opts?: SkillPathsOpts): void {
  let failedSyncs = 0;
  for (const target of targets) {
    try {
      syncSkill(target.id, target.dirName, opts);
    } catch (err) {
      failedSyncs += 1;
      console.error(`[skills] Failed to sync skill "${target.id}":`, err instanceof Error ? err.message : err);
    }
  }

  const dir = claudeSkillsDir(opts);
  if (!fs.existsSync(dir)) return;

  // Remove staging dirs a killed daemon left inside the scanned skills dir
  // (best-effort, age-guarded; see dirsync.sweepStaleMirrorArtifacts).
  sweepStaleMirrorArtifacts(dir);

  if (failedSyncs > 0) {
    console.warn(
      `[skills] Skipping orphan cleanup: ${failedSyncs} target(s) failed to sync this pass ` +
        '(removing dirs now could delete the only copy of a renamed skill)',
    );
    return;
  }

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
  const planned = new Set(targets.map((t) => t.dirName));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(MOLIO_PREFIX)) continue; // never touch user skills
    // Staging artifacts (`molio--<x>.tmp/bak-…`) belong to the sweep's
    // age-guarded domain: an in-flight mirror of a FRESH artifact would be
    // rm -rf'd under the other process if the orphan scan claimed it here.
    if (isMirrorArtifactName(entry.name)) continue;
    const dirName = entry.name.slice(MOLIO_PREFIX.length);
    if (!planned.has(dirName)) {
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
