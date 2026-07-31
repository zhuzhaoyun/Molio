/**
 * Skills shared types — the user-managed global skill library.
 *
 * Skill metadata + the global master switch live in the daemon's SQLite `skills`
 * table (replacing the old `~/.molio/skills/manifest.json`). A skill's body is
 * still a file: library/core skills write `~/.molio/skills/<id>/SKILL.md`, while
 * bundled skills ship their content under the app resources (`tools/skills/<id>/`).
 *
 * Three kinds:
 *  - `bundled`: multi-file skills shipped with Molio (docling / wiki-* / remotion /
 *    wechat). Shown + configurable. Synced whole-dir to `<vault>/.claude/skills/<id>/`
 *    (plain dir name, no `molio--` prefix).
 *  - `library`: user-created/imported single-file skills. Shown + configurable.
 *    Synced to `<vault>/.claude/skills/molio--<id>/SKILL.md`.
 *  - core (`core: true`): the writing trio — Molio's core job. NOT shown, NOT
 *    configurable, always enabled; synced like a library skill.
 */

export type SkillKind = 'bundled' | 'library';

export interface SkillManifestEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** True for Molio-shipped curated skills (seeded on startup, cannot be deleted). */
  builtIn: boolean;
  /** 'bundled' (multi-file, shipped) or 'library' (single-file, user-managed). Defaults to 'library'. */
  kind?: SkillKind;
  /** Core app functionality (writing trio): hidden, always-on, not configurable. */
  core?: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

// ─── Request types ───

export interface CreateSkillRequest {
  name: string;
  description: string;
  instructions: string;
}

export interface UpdateSkillRequest {
  name?: string;
  description?: string;
  instructions?: string;
}

/**
 * Import a skill from pasted SKILL.md raw text OR a local folder path
 * (daemon reads `<folderPath>/SKILL.md`). Exactly one must be provided.
 */
export interface ImportSkillRequest {
  raw?: string;
  folderPath?: string;
}

export interface PrefillRequest {
  /** Assistant message content to summarize into a skill definition. */
  content: string;
}

// ─── Response types ───

export interface PrefillResult {
  name: string;
  description: string;
  instructions: string;
  /** True when the AI prefill failed/unavailable and this is a raw-content fallback. */
  fallback?: boolean;
}

export interface SkillListResponse {
  skills: SkillManifestEntry[];
}

export interface SkillResponse {
  skill: SkillManifestEntry;
}

export interface PrefillResponse {
  prefill: PrefillResult;
}

// ─── Per-vault skill enablement ───

/**
 * A skill as seen from one vault. The global manifest `enabled` flag is the
 * master switch (`globalEnabled`); a vault may opt out, so the effective state
 * is `vaultEnabled = globalEnabled && !vaultOptOut`. A globally-disabled skill
 * surfaces greyed-out and cannot be enabled at the vault level.
 */
export interface VaultSkillEntry {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  /** 'bundled' or 'library' (see SkillManifestEntry). */
  kind?: SkillKind;
  /** Master switch from the global skill library. */
  globalEnabled: boolean;
  /** Effective state in this vault = globalEnabled && not disabled here. */
  vaultEnabled: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

export interface VaultSkillListResponse {
  skills: VaultSkillEntry[];
}

export interface VaultSkillToggleRequest {
  enabled: boolean;
}
