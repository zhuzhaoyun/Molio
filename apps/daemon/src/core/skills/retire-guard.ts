/**
 * Retirement guard — runs BEFORE seedBuiltinSkills deletes retired bundled
 * rows on startup (index.ts ordering: guard → seed → fan-out).
 *
 * Why the ordering is load-bearing: once the row is gone, so is its
 * `custom_instructions` overlay — and with it any record of what the vault
 * copies of that skill contained. A retired skill whose overlay was in play
 * has user-customized copies in vaults that the normal step-3 removal can
 * only delete with a byte-proof against the (overlay-free) shipped source —
 * proof that will never match. Without this guard those copies linger as
 * orphans forever, or worse get destroyed unproven. So: while the row still
 * exists, hand every vault copy to the quarantine, ledger a `retired` event,
 * and remove the dir (no orphans). Idempotent — after the seed deletes the
 * row, subsequent runs are a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { listVaults } from '../db.js';
import { RETIRED_BUNDLED_SKILLS, resolveSkillsSourceDir } from '../skill-installer.js';
import { quarantineDir, recordQuarantineEvent } from './quarantine.js';
import { materializeComposedSource } from './compose.js';
import type { SkillPathsOpts } from './paths.js';

export function quarantineRetiredWithOverlay(db: Database.Database, opts?: SkillPathsOpts): void {
  for (const slug of RETIRED_BUNDLED_SKILLS) {
    const row = db
      .prepare('SELECT custom_instructions FROM skills WHERE id = ? AND kind = ?')
      .get(slug, 'bundled') as { custom_instructions: string | null } | undefined;
    if (!row?.custom_instructions) continue; // no overlay ⇒ normal step-3 machinery owns it

    let preservedAnyCopy = false;
    for (const vault of listVaults(db)) {
      const copy = path.join(vault.path, '.claude', 'skills', slug);
      if (!fs.existsSync(copy)) continue;
      const quarantinedPath = quarantineDir(copy, `retired-${slug}`, opts);
      if (quarantinedPath === null) {
        // Backup failed: KEEP the dir (better an orphan than destroyed user
        // content) — step 3's proof will also refuse it, so it stays until a
        // later run succeeds or the user removes it.
        console.warn(`[retire-guard] Quarantine failed for "${copy}" — keeping the dir`);
        continue;
      }
      recordQuarantineEvent(db, {
        source: 'retired',
        skillId: slug,
        mirrorName: slug,
        description: `内置技能「${slug}」已在当前版本退役；你在其上的自定义内容已备份，可整理进其他技能或「自定义指令」。`,
        quarantinedPath,
      });
      try {
        fs.rmSync(copy, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[retire-guard] Failed to remove quarantined copy "${copy}":`,
          err instanceof Error ? err.message : err,
        );
      }
      preservedAnyCopy = true;
    }

    // No vault carried a copy (zero vaults / offline disks), but the overlay
    // itself is user-authored text and must not die with the row the seed is
    // about to delete. The retired skill's source dir is deliberately KEPT in
    // the app resources (see RETIRED_BUNDLED_SKILLS) — compose it with the
    // overlay and preserve THAT.
    if (!preservedAnyCopy) {
      const src = path.join(resolveSkillsSourceDir(), slug);
      if (fs.existsSync(src)) {
        const composed = materializeComposedSource(src, row.custom_instructions);
        try {
          const quarantinedPath = quarantineDir(composed.dir, `retired-${slug}`, opts);
          if (quarantinedPath !== null) {
            recordQuarantineEvent(db, {
              source: 'retired',
              skillId: slug,
              mirrorName: slug,
              description: `内置技能「${slug}」已在当前版本退役；你的自定义指令已随其内容一并备份。`,
              quarantinedPath,
            });
          } else {
            console.warn(`[retire-guard] Synthetic preservation failed for "${slug}"`);
          }
        } finally {
          composed.dispose();
        }
      }
    }
  }
}
