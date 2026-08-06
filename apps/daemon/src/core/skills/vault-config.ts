/**
 * Per-vault skill sync.
 *
 * The global skill library (the daemon's `skills` table) is the master switch:
 * a globally-enabled skill is available in every vault. The effective set for
 * a vault is therefore:
 *
 *     globally-enabled OR core
 *
 * `core` skills (the writing trio) are exempt from the global switch — they
 * are always effective (hidden but behavior kept).
 *
 * NOTE: the API stays per-vault (`getEffectiveSkills(db, vaultId)`) on purpose.
 * If per-vault opt-outs ever become a real need again, re-add them as a filter
 * here — the sync layer below already fans out per vault and wouldn't change.
 *
 * Scope: sync targets ONLY registered vaults' `<vault.path>/.claude/skills/`,
 * so skills reach runs whose cwd resolves to a vault. Runs without a vault
 * (pre-vault home chat, channels whose defaultCwd is not a vault path) do not
 * see library/bundled/core skills.
 *
 * Sync splits the effective set by kind:
 *  - **library + core** → `reconcileSync` (sync.ts) pointed at `<vault>/.claude`,
 *    writing single-file `molio--<id>/SKILL.md` dirs (keeps the molio-- red line
 *    + orphan cleanup for free);
 *  - **bundled** → `reconcileBundledSync` (skill-installer.ts), syncing whole
 *    multi-file directories under their plain names and converging the CLAUDE.md
 *    rule blocks.
 * Every supported runtime (Claude Code / Codex / Gemini / Qwen) reads
 * `<cwd>/.claude/skills/`.
 *
 * All filesystem sync is best-effort: on NAS/Docker the mounted docs dir is
 * often root-owned while the daemon runs unprivileged, so an EACCES there must
 * degrade to a warning, never abort vault provisioning (see default-vault.ts).
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { SkillManifestEntry, Vault } from '@molio/contracts';
import { listVaults } from '../db.js';
import { listSkills } from './store.js';
import { reconcileSync } from './sync.js';
import { reconcileBundledSync } from '../skill-installer.js';
import type { SkillPathsOpts } from './paths.js';

/**
 * Effective skill entries for a vault: core skills always count (exempt from
 * the global switch); everything else needs to be globally enabled. `_vaultId`
 * is kept in the signature so per-vault filtering can be re-added without
 * touching callers (see module note).
 */
export function getEffectiveSkills(db: Database.Database, _vaultId: string): SkillManifestEntry[] {
  return listSkills(db).filter((s) => s.core || s.enabled);
}

/** Effective skill ids for a vault (see getEffectiveSkills). */
export function getEffectiveSkillIds(db: Database.Database, vaultId: string): string[] {
  return getEffectiveSkills(db, vaultId).map((s) => s.id);
}

/**
 * Reconcile one vault's `<vault.path>/.claude/skills/` against its effective
 * skill set, splitting by kind:
 *  - library + core → `reconcileSync` (single-file `molio--<id>/SKILL.md`);
 *  - bundled → `reconcileBundledSync` (whole multi-file dirs, plain names, plus
 *    CLAUDE.md rule convergence).
 * Best-effort: an EACCES on the mounted dir logs and returns rather than
 * throwing, so callers (vault creation, startup fan-out) are never aborted.
 */
export function reconcileVault(db: Database.Database, vault: Vault, opts?: SkillPathsOpts): void {
  try {
    const effective = getEffectiveSkills(db, vault.id);

    // library + core → molio-- single-file sync (orphan cleanup included).
    const singleFileIds = effective.filter((s) => s.kind !== 'bundled').map((s) => s.id);
    reconcileSync(singleFileIds, { ...opts, claudeHome: path.join(vault.path, '.claude') });

    // bundled → whole-dir sync. Managed = every bundled row the DB knows about
    // (so a toggled-off one gets removed); effective = the subset that's on.
    const allSkills = listSkills(db);
    const managedBundled = new Set(allSkills.filter((s) => s.kind === 'bundled').map((s) => s.id));
    const effectiveBundled = new Set(effective.filter((s) => s.kind === 'bundled').map((s) => s.id));
    reconcileBundledSync(effectiveBundled, managedBundled, vault.path);
  } catch (err) {
    console.warn(
      `[skills] Failed to reconcile skills into vault "${vault.name}" (${vault.path}) — ` +
        `likely a write-permission problem on the directory. The vault is still usable. Cause:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Reconcile every vault; one vault failing never blocks the others. */
export function reconcileAllVaults(db: Database.Database, opts?: SkillPathsOpts): void {
  for (const vault of listVaults(db)) {
    reconcileVault(db, vault, opts);
  }
}

/**
 * Async variant of reconcileAllVaults for the startup fan-out and mutation
 * routes: yields to the event loop between vaults so HTTP stays responsive
 * while a many-vault sync runs. The fully synchronous version blocked the
 * daemon for >10s on a cold cache (13+ vaults × ~1.2s each), which pushed the
 * packaged app's first launch past the desktop shell's startup timeout.
 */
export async function reconcileAllVaultsAsync(
  db: Database.Database,
  opts?: SkillPathsOpts,
): Promise<void> {
  for (const vault of listVaults(db)) {
    reconcileVault(db, vault, opts);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Remove the legacy global `~/.claude/skills/molio--*` sync left over from the
 * pre-per-vault design. Idempotent and safe to run on every startup. `opts` is
 * injectable so tests can point it at a temp `claudeHome` (never the real home).
 */
export function cleanupLegacyGlobalSync(opts?: SkillPathsOpts): void {
  reconcileSync([], opts ?? {});
}

/**
 * Facade for skills routes: call after ANY global library mutation (create /
 * update / toggle / import / delete) so every vault's sync catches up. Keeping
 * this in one place means a new mutation endpoint can't forget to re-sync.
 * Async (yields between vaults) so a many-vault fan-out doesn't freeze every
 * in-flight HTTP request for the whole sync duration.
 */
export async function afterGlobalSkillMutation(
  db: Database.Database,
  opts?: SkillPathsOpts,
): Promise<void> {
  await reconcileAllVaultsAsync(db, opts);
}
