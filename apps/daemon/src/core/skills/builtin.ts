/**
 * Built-in skills shipped with Molio, seeded idempotently into the daemon's
 * `skills` table on startup.
 *
 * Bundled skills (docling / wiki-* / wechat-article-extractor) are app-owned
 * functionality: hidden from the settings UI and always effective regardless
 * of the `enabled` flag (see vault-config.ts + routes/skills.ts). Multi-file
 * content lives under the app resources (`tools/skills/<slug>/`); only a
 * metadata row is inserted (createSkill skips writing a library SKILL.md for
 * kind='bundled'); synced whole-dir by reconcileBundledSync. They back
 * deterministic app paths (KB panel wiki actions, channel routing, docling
 * preload), hence not user-toggleable. name/description are read from the
 * shipped SKILL.md frontmatter; hardcoded fallbacks cover a missing/
 * unreadable source dir.
 *
 * Older versions also seeded a "core" writing trio (write-article / summarize
 * / polish-rewrite) into every vault. Those skills were REMOVED — startup now
 * retires their rows (RETIRED_CORE_SKILLS) and the per-vault `molio--*`
 * mirrors converge away via the orphan cleanup (sync.ts).
 *
 * Seeding is idempotent: an existing row (by id) only gets its name/description
 * refreshed — `enabled` is NEVER overwritten, so the user's toggle state
 * survives restarts/upgrades.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parseSkillMd } from '@molio/contracts';
import { assertSafeSkillPathSegment, skillContentDir, type SkillPathsOpts } from './paths.js';
import { createSkill, getSkill } from './store.js';
import { BUILTIN_SKILLS, RETIRED_BUNDLED_SKILLS, resolveSkillsSourceDir } from '../skill-installer.js';

/**
 * The former "core" writing trio, seeded by older versions and removed since.
 * Startup deletes their `skills` rows (guarded on core=1 so a user library
 * skill with a coincidentally identical id survives) plus their library
 * content dirs; the per-vault `molio--<dirName>` mirrors drop out of the
 * planned set and are swept by the orphan cleanup on the next reconcile.
 */
export const RETIRED_CORE_SKILLS = ['write-article', 'summarize', 'polish-rewrite'];

/** Fallback display metadata for bundled skills if the shipped SKILL.md can't be read. */
const BUNDLED_FALLBACK: Record<string, { name: string; description: string }> = {
  'wechat-article-extractor': {
    name: '微信文章提取',
    description: '提取微信公众号文章（mp.weixin.qq.com）内容为 Markdown。',
  },
  docling: {
    name: 'docling',
    description: '将 PDF / Office / 图片 / 音视频转换为 Markdown（GPU OCR + 版面 + 表格）。',
  },
  'wiki-build': { name: 'wiki-build', description: '构建/重建本地知识库的 Wiki。' },
  'wiki-ingest': { name: 'wiki-ingest', description: '将源文件/资料增量导入（入库）到现有 wiki。' },
  'wiki-lint': { name: 'wiki-lint', description: '对知识库 Wiki 做健康检查/质量审查。' },
  'wiki-save': { name: 'wiki-save', description: '将当前对话中有价值的内容归档为 wiki 页面。' },
  'wiki-query': { name: 'wiki-query', description: '基于已构建的 wiki 和源文件回答库内问题/为库内任务提供依据。' },
};

/** Read a bundled skill's display name/description from its shipped SKILL.md frontmatter. */
function readBundledMeta(slug: string, sourceDir: string): { name: string; description: string } {
  const fallback = BUNDLED_FALLBACK[slug] ?? { name: slug, description: '' };
  try {
    const md = path.join(sourceDir, slug, 'SKILL.md');
    if (!fs.existsSync(md)) return fallback;
    const parsed = parseSkillMd(fs.readFileSync(md, 'utf8'));
    return {
      name: parsed.name.trim() || fallback.name,
      description: parsed.description.trim() || fallback.description,
    };
  } catch {
    return fallback;
  }
}

/**
 * Read a bundled skill's shipped SKILL.md body ('' when unreadable). Bundled
 * skills have NO library content dir (content ships under the app resources),
 * so `readInstructions` returns '' for them — the "duplicate" flow uses this
 * instead so copying a bundled skill prefills its real instructions.
 * `sourceDir` is injectable for tests.
 */
export function readBundledInstructions(slug: string, sourceDir?: string): string {
  try {
    // Defense in depth: this is an exported file-read entry point (GET
    // /api/skills/:id). Callers pass DB-derived slugs today, but a traversal
    // id like '../..' must never build a path — assertSafeSkillPathSegment
    // throws and the catch below degrades to ''.
    assertSafeSkillPathSegment(slug);
    const md = path.join(sourceDir ?? resolveSkillsSourceDir(), slug, 'SKILL.md');
    if (!fs.existsSync(md)) return '';
    return parseSkillMd(fs.readFileSync(md, 'utf8')).instructions;
  } catch {
    return '';
  }
}

/**
 * Seed all built-in skills into the `skills` table. Idempotent — an existing row
 * only has its name/description refreshed; `enabled` is never touched.
 */
export function seedBuiltinSkills(db: Database.Database, opts?: SkillPathsOpts): void {
  const sourceDir = resolveSkillsSourceDir();

  // 0. Retired bundled skills (shipped by older versions, no longer bundled):
  //    drop their rows so they stop counting as app-owned always-on skills.
  //    Runs on every startup (idempotent). The kind='bundled' guard only ever
  //    touches Molio's own seeded rows — a user library skill with a
  //    coincidentally identical id is left alone. Removing the row is half the
  //    migration: reconcileVault additionally unions RETIRED_BUNDLED_SKILLS
  //    into the managed set so the per-vault `<vault>/.claude/skills/<slug>/`
  //    copies converge away too (vault-config.ts).
  const deleteRetired = db.prepare(`DELETE FROM skills WHERE id = ? AND kind = 'bundled'`);
  for (const slug of RETIRED_BUNDLED_SKILLS) {
    deleteRetired.run(slug);
  }

  // 1. Bundled skills (multi-file, shipped) — hidden + always-on (app-owned).
  for (const slug of BUILTIN_SKILLS) {
    const meta = readBundledMeta(slug, sourceDir);
    const existing = getSkill(db, slug);
    if (existing) {
      refreshMeta(db, slug, meta.name, meta.description);
      continue;
    }
    createSkill(
      db,
      { id: slug, name: meta.name, description: meta.description, enabled: true, builtIn: true, kind: 'bundled' },
      '',
      opts,
    );
  }

  // 2. Retired core skills (the former writing trio, removed): delete their
  //    rows so they stop counting toward the effective set, and remove their
  //    library content dirs. Runs on every startup (idempotent). The core=1
  //    guard only ever touches Molio's own seeded rows — a user library skill
  //    with a coincidentally identical id keeps its row AND its content dir
  //    (the rmSync is gated on the delete actually hitting a row). The
  //    per-vault `molio--<dirName>` mirrors need no explicit handling: once
  //    the row is gone the skill drops out of the planned set and the orphan
  //    cleanup in sync.ts sweeps its dir on the next fully-successful
  //    reconcile. The dir removal itself is best-effort (EACCES on NAS must
  //    degrade to a warning, never abort seeding — a leftover dir is dead
  //    weight, not a correctness problem).
  const deleteRetiredCore = db.prepare('DELETE FROM skills WHERE id = ? AND core = 1');
  for (const id of RETIRED_CORE_SKILLS) {
    const { changes } = deleteRetiredCore.run(id);
    if (changes > 0) {
      try {
        fs.rmSync(skillContentDir(id, opts), { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[skills] Failed to remove retired core skill content dir "${id}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/**
 * Update only name/description of an existing row — never enabled. The
 * WHERE clause makes it a no-op when nothing changed, so re-seeding on every
 * startup doesn't churn `updated_at` for identical metadata.
 */
function refreshMeta(db: Database.Database, id: string, name: string, description: string): void {
  db.prepare(
    `UPDATE skills SET name = ?, description = ?, updated_at = ?
     WHERE id = ? AND (name != ? OR description != ?)`,
  ).run(name, description, Date.now(), id, name, description);
}

/**
 * Startup entry: seed built-ins into the `skills` table (the master-switch
 * source). Idempotent. Per-vault sync is a separate step (see index.ts:
 * reconcileAllVaults after this, then cleanupLegacyGlobalSync) — seeding never
 * touches any vault.
 *
 * Returns false when seeding failed. Callers MUST skip the per-vault fan-out in
 * that case: reconciling against a (partially) empty table would treat the
 * missing rows as disabled and DELETE skills that earlier starts already
 * synced into every vault.
 */
export function initSkillLibrary(db: Database.Database, opts?: SkillPathsOpts): boolean {
  try {
    seedBuiltinSkills(db, opts);
    return true;
  } catch (err) {
    console.error('[skills] Failed to initialize skill library:', err instanceof Error ? err.message : err);
    return false;
  }
}
