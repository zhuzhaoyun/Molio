/**
 * Guarded mirroring — dirsync with a memory and a conscience.
 *
 * `mirrorDirIfChanged` (dirsync.ts) rebuilds a mirror on ANY drift, which is
 * exactly right for Molio's own churn and exactly wrong when the drift is a
 * user's hand edit: it silently destroys it (the bug this feature exists to
 * fix). `guardedMirror` wraps the mirror with a baseline table
 * (`skill_mirror_state`) that remembers what Molio last wrote, so drift can be
 * told apart from upstream updates:
 *
 *   dest == src        → adopt/refresh baseline only (dirsync short-circuit kept)
 *   dest == baseline   → silent rebuild (normal update), baseline advances
 *   dest != baseline   → USER DRIFT: quarantine copy + event, then rebuild
 *   dest, no baseline  → COLD START (first run after upgrade): can't attribute
 *                        (the old source died with the app update) — quarantine
 *                        + aggregated cold-start event, then rebuild (2026-11-19
 *                        拍板：隔离+聚合提示)
 *
 * Baselines record the hash of the COMPOSED view (what was actually mirrored),
 * so overlay edits through the API never false-positive as drift.
 *
 * Scope: vault-destination mirrors only (bundled plain dirs + library molio--*
 * dirs). The hub content-dir refresh and the legacy ~/.claude cleanup are NOT
 * vault mirrors and must not route through here (design §5.6 wiring decision).
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { hashDir, mirrorDirIfChanged } from './dirsync.js';
import { quarantineDir, recordQuarantineEvent } from './quarantine.js';
import type { SkillPathsOpts } from './paths.js';

export function getMirrorHash(db: Database.Database, vaultPath: string, mirrorDir: string): string | null {
  const row = db
    .prepare('SELECT content_hash FROM skill_mirror_state WHERE vault_path = ? AND mirror_dir = ?')
    .get(vaultPath, mirrorDir) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

export function setMirrorHash(
  db: Database.Database,
  vaultPath: string,
  mirrorDir: string,
  hash: string,
): void {
  db.prepare(
    `INSERT INTO skill_mirror_state (vault_path, mirror_dir, content_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(vault_path, mirror_dir) DO UPDATE
       SET content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
  ).run(vaultPath, mirrorDir, hash, Date.now());
}

/** Parameters for one guarded mirror of a skill dir into a vault. */
export interface GuardedMirrorParams {
  /** The COMPOSED source dir (caller ran materializeComposedSource) — invariant. */
  srcDir: string;
  /** Destination mirror dir inside the vault's skills dir. */
  destDir: string;
  /** Vault path — baseline scope key. */
  vaultPath: string;
  /** Mirror dir name (slug or molio--<dirName>) — baseline scope key. */
  mirrorDir: string;
  /** Quarantine label: `<kind>-<slug>`. */
  label: string;
  /** Skill id for the event ledger (optional). */
  skillId?: string;
}

/** Test seam (preload-manager __setPreloadPythonHooksForTest pattern). */
interface MirrorStateDeps {
  mirrorDirIfChanged: typeof mirrorDirIfChanged;
  quarantineDir: typeof quarantineDir;
}

let deps: MirrorStateDeps = { mirrorDirIfChanged, quarantineDir };

/** @internal Inject alternative dep behavior for tests; null restores real. */
export function __setMirrorStateDepsForTest(override: Partial<MirrorStateDeps> | null): void {
  deps = override ? { ...deps, ...override } : { mirrorDirIfChanged, quarantineDir };
}

/** hashDir that degrades to null instead of throwing (unreadable dest). */
function tryHashDir(dir: string): string | null {
  try {
    return hashDir(dir);
  } catch {
    return null;
  }
}

/**
 * Mirror `srcDir` → `destDir` with drift detection and quarantine. Throws only
 * when the underlying mirror throws (baseline then stays put — a wrong
 * baseline is worse than a missing one); every quarantine/ledger failure is
 * best-effort and swallowed.
 */
export function guardedMirror(
  db: Database.Database,
  params: GuardedMirrorParams,
  opts?: SkillPathsOpts,
): void {
  const { srcDir, destDir, vaultPath, mirrorDir, label, skillId } = params;

  const srcHash = hashDir(srcDir); // caller guarantees a readable composed source
  const destExists = fs.existsSync(destDir);
  const destHash = destExists ? tryHashDir(destDir) : null;

  // Already in sync: adopt/refresh the baseline, zero writes (keeps dirsync's
  // short-circuit semantics — especially on NAS-mounted vaults).
  if (destHash !== null && destHash === srcHash) {
    setMirrorHash(db, vaultPath, mirrorDir, destHash);
    return;
  }

  // Dest exists but differs: someone changed it vs. what we last wrote —
  // unless it merely predates the baseline table (cold start). Both cases
  // quarantine first; the event source tells the UI which banner to show.
  if (destExists) {
    const baseline = getMirrorHash(db, vaultPath, mirrorDir);
    const drifted = destHash === null || destHash !== baseline;
    if (drifted) {
      const quarantinedPath = deps.quarantineDir(destDir, label, opts);
      const source = baseline === null ? 'vault-cold-start' : 'vault-drift';
      const description =
        quarantinedPath === null
          ? `技能镜像「${mirrorDir}」与官方版本不一致，隔离备份失败（原内容被更新覆盖；若你改过它，请从该镜像路径找回）。`
          : `技能镜像「${mirrorDir}」${baseline === null ? '升级后首次同步存在差异' : '检测到本地修改'}，原内容已备份，可整理进「自定义指令」。`;
      recordQuarantineEvent(db, {
        source,
        ...(skillId ? { skillId } : {}),
        mirrorName: mirrorDir,
        description,
        quarantinedPath: quarantinedPath ?? destDir,
      });
    }
  }

  // The rebuild itself. On failure the baseline deliberately stays at the old
  // value — the next pass re-evaluates against what is actually on disk.
  deps.mirrorDirIfChanged(srcDir, destDir);
  setMirrorHash(db, vaultPath, mirrorDir, hashDir(destDir));
}

/** Parameters for the guarded removal of an orphaned mirror dir. */
export interface GuardedOrphanParams {
  /** The orphan dir on disk (e.g. `<vault>/.claude/skills/molio--old-name`). */
  destDir: string;
  /** Baseline key: the full mirror dir name (`molio--<dirName>`). */
  mirrorDir: string;
  vaultPath: string;
  /** Quarantine label: `lib-<dirName>`. */
  label: string;
  /** Event description (rename/disable context is caller-specific). */
  description: string;
  skillId?: string;
}

/**
 * Decide whether an orphaned mirror dir may be removed, with the same
 * never-silently-destroy rule as guardedMirror:
 *  - dest hash == last-synced baseline → provably Molio's own pristine copy →
 *    removable WITHOUT backup or event (renames stay noise-free);
 *  - anything else (hand-edited, or no baseline to prove provenance) →
 *    quarantine copy + `orphan-sweep` event first; if the backup fails the
 *    dir is KEPT (return false) — garbage beats destruction.
 */
export function guardedOrphanRemove(
  db: Database.Database,
  params: GuardedOrphanParams,
  opts?: SkillPathsOpts,
): boolean {
  const baseline = getMirrorHash(db, params.vaultPath, params.mirrorDir);
  const destHash = tryHashDir(params.destDir);
  if (baseline !== null && destHash !== null && destHash === baseline) return true;

  const quarantinedPath = deps.quarantineDir(params.destDir, params.label, opts);
  if (quarantinedPath === null) {
    console.warn(
      `[skills] Orphan dir "${params.destDir}" kept: quarantine backup failed (refusing to destroy without backup)`,
    );
    return false;
  }
  recordQuarantineEvent(db, {
    source: 'orphan-sweep',
    ...(params.skillId ? { skillId: params.skillId } : {}),
    mirrorName: params.mirrorDir,
    description: params.description,
    quarantinedPath,
  });
  return true;
}
