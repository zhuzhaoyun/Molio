/**
 * Skill library store — DB-backed CRUD + SKILL.md materialization.
 *
 * The daemon's SQLite `skills` table is the source of truth for metadata + the
 * global enabled state (master switch); each library/core skill's content lives
 * in `~/.molio/skills/<id>/`. A library skill is usually a single generated
 * `SKILL.md`, but an IMPORTED skill may be a whole multi-file directory (SKILL.md
 * + reference/script siblings) copied in verbatim — sync.ts mirrors the entire
 * directory either way. Bundled skills keep their content under the app resources
 * (`tools/skills/<id>/`), so no content file is written for them — only a row.
 *
 * This module is pure catalog CRUD and does NOT sync anywhere. Propagating
 * enabled skills into each vault's `<vault>/.claude/skills/` is handled by
 * vault-config.ts (bundled → whole-dir, library/core → molio-- single file) and
 * triggered by the routes after a mutation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateSkillMd, stripFrontmatter } from '@molio/contracts';
import type { SkillKind, SkillManifestEntry } from '@molio/contracts';
import { skillContentDir, type SkillPathsOpts } from './paths.js';
import { copyDirSync } from './dirsync.js';

export class SkillNotFoundError extends Error {
  constructor(id: string) {
    super(`Skill not found: ${id}`);
    this.name = 'SkillNotFoundError';
  }
}

/** Shape of a row in the `skills` table. */
interface SkillRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  core: number;
  built_in: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: SkillRow): SkillManifestEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: (row.kind === 'bundled' ? 'bundled' : 'library') satisfies SkillKind,
    core: row.core !== 0,
    builtIn: row.built_in !== 0,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSkills(db: Database.Database): SkillManifestEntry[] {
  const rows = db.prepare('SELECT * FROM skills ORDER BY created_at ASC').all() as SkillRow[];
  return rows.map(rowToEntry);
}

export function getSkill(db: Database.Database, id: string): SkillManifestEntry | null {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
  return row ? rowToEntry(row) : null;
}

function writeSkillMd(
  id: string,
  name: string,
  description: string,
  instructions: string,
  opts?: SkillPathsOpts,
): void {
  const dir = skillContentDir(id, opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), generateSkillMd(name, description, instructions), 'utf8');
}

/** Read a skill's current instructions body from its SKILL.md ('' for bundled, which have no library file). */
export function readInstructions(id: string, opts?: SkillPathsOpts): string {
  const md = path.join(skillContentDir(id, opts), 'SKILL.md');
  if (!fs.existsSync(md)) return '';
  return stripFrontmatter(fs.readFileSync(md, 'utf8')).trim();
}

export interface CreateSkillInput {
  /** Stable id for built-in/bundled seeds; a UUID is generated when omitted. */
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  builtIn: boolean;
  /** 'bundled' (multi-file, shipped) or 'library' (single-file). Defaults to 'library'. */
  kind?: SkillKind;
  /** Core app functionality (writing trio): hidden + always-on + not configurable. */
  core?: boolean;
  /**
   * Import a whole existing directory as the skill's content (multi-file skill:
   * SKILL.md + siblings copied verbatim). When set for a non-bundled skill it
   * replaces the generated-SKILL.md path — `instructions` is then ignored for
   * writing (the directory already carries its own SKILL.md).
   */
  sourceDir?: string;
}

/**
 * Create a skill row (+ its SKILL.md content file for library/core skills).
 * Bundled skills have their content shipped under `tools/skills/<id>/`, so no
 * content file is written for them — only the metadata row.
 */
export function createSkill(
  db: Database.Database,
  input: CreateSkillInput,
  instructions: string,
  opts?: SkillPathsOpts,
): SkillManifestEntry {
  const now = Date.now();
  const kind: SkillKind = input.kind ?? 'library';
  const core = input.core ?? false;
  const entry: SkillManifestEntry = {
    id: input.id ?? randomUUID(),
    name: input.name,
    description: input.description,
    kind,
    core,
    enabled: input.enabled,
    builtIn: input.builtIn,
    createdAt: now,
    updatedAt: now,
  };

  // Library + core skills carry their content under ~/.molio/skills/<id>.
  if (kind !== 'bundled') {
    if (input.sourceDir) {
      // Multi-file import: copy the whole source tree verbatim (its own SKILL.md
      // + any reference/script siblings). Fresh UUID dir → no stale files.
      copyDirSync(input.sourceDir, skillContentDir(entry.id, opts));
    } else {
      writeSkillMd(entry.id, entry.name, entry.description, instructions, opts);
    }
  }

  db.prepare(
    `INSERT INTO skills (id, name, description, kind, core, built_in, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.name,
    entry.description,
    kind,
    core ? 1 : 0,
    entry.builtIn ? 1 : 0,
    entry.enabled ? 1 : 0,
    entry.createdAt,
    entry.updatedAt,
  );
  return entry;
}

export interface UpdateSkillPatch {
  name?: string;
  description?: string;
  instructions?: string;
}

/** Update name/description (+ instructions body for library/core). Bundled skills are not editable (guarded by the route). */
export function updateSkill(
  db: Database.Database,
  id: string,
  patch: UpdateSkillPatch,
  opts?: SkillPathsOpts,
): SkillManifestEntry {
  const entry = getSkill(db, id);
  if (!entry) throw new SkillNotFoundError(id);

  if (patch.name !== undefined) entry.name = patch.name;
  if (patch.description !== undefined) entry.description = patch.description;
  entry.updatedAt = Date.now();

  // Library/core carry their body in SKILL.md; rewrite it when any field changes.
  // NOTE: imported multi-file skills may ship extra frontmatter fields
  // (allowed-tools, license, ...); generateSkillMd regenerates the frontmatter
  // with name/description/version only, so such extra fields are dropped on
  // edit. Accepted in v1 — the UI only edits these three fields.
  if (entry.kind !== 'bundled') {
    const instructions = patch.instructions ?? readInstructions(id, opts);
    writeSkillMd(entry.id, entry.name, entry.description, instructions, opts);
  }

  db.prepare(
    'UPDATE skills SET name = ?, description = ?, updated_at = ? WHERE id = ?',
  ).run(entry.name, entry.description, entry.updatedAt, id);
  return entry;
}

/** Flip the global master switch for a skill. */
export function toggleSkill(
  db: Database.Database,
  id: string,
  enabled: boolean,
): SkillManifestEntry {
  const entry = getSkill(db, id);
  if (!entry) throw new SkillNotFoundError(id);

  entry.enabled = enabled;
  entry.updatedAt = Date.now();
  db.prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    entry.updatedAt,
    id,
  );
  return entry;
}

/** Delete a skill row + its library content dir (bundled content is app-owned and left alone). Idempotent. */
export function deleteSkill(db: Database.Database, id: string, opts?: SkillPathsOpts): void {
  const entry = getSkill(db, id);
  if (!entry) return; // idempotent

  if (entry.kind !== 'bundled') {
    fs.rmSync(skillContentDir(id, opts), { recursive: true, force: true });
  }
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
}
