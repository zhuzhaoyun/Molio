/**
 * Skills shared types — the user-managed global skill library.
 *
 * Skill metadata + the global master switch live in the daemon's SQLite `skills`
 * table (replacing the old `~/.molio/skills/manifest.json`). A skill's body is
 * still a file: library/core skills write `~/.molio/skills/<id>/SKILL.md`, while
 * bundled skills ship their content under the app resources (`tools/skills/<id>/`).
 *
 * Three kinds:
 *  - `bundled`: multi-file skills shipped with Molio (docling / wiki-* / wechat).
 *    Hidden from the settings UI and always effective (app-owned). Synced whole-dir
 *    to `<vault>/.claude/skills/<id>/` (plain dir name, no `molio--` prefix).
 *  - `library`: user-created/imported single-file skills. Shown + configurable.
 *    Synced to `<vault>/.claude/skills/molio--<dirName>/SKILL.md` where dirName
 *    is the slugified display name (readable; same-name collisions get a stable
 *    id-derived suffix).
 *  - core (`core: true`): the writing trio — Molio's core job. NOT shown, NOT
 *    configurable, always enabled; synced like a library skill.
 *
 * Scope: sync writes ONLY into each registered vault's `.claude/skills/`, so
 * skills reach runs whose cwd is inside a vault. Runs without a vault (home
 * chat before any vault exists, channels whose defaultCwd isn't a vault path)
 * get no library/bundled/core skills — "always enabled" means "always enabled
 * within vault-scoped runs".
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
 * Import a skill from pasted SKILL.md raw text OR a local path. Despite the
 * name, `folderPath` accepts EITHER a directory whose ROOT holds a SKILL.md
 * (imported as a whole multi-file skill) or a direct path to a .md file
 * (imported as a single-file skill). Exactly one of raw/folderPath must be
 * provided.
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

/**
 * One skill + its SKILL.md body (GET /api/skills/:id, for the edit/duplicate
 * form). Bundled skills have no library file, so their body is read from the
 * shipped app-resources SKILL.md ('' only if that is unreadable).
 */
export interface SkillDetailResponse {
  skill: SkillManifestEntry;
  instructions: string;
}

export interface PrefillResponse {
  prefill: PrefillResult;
}

// ─── Skill hub (marketplace) types ───
//
// The daemon proxies the public skillhub.cn catalog (browse/search) and
// installs a hub skill by downloading its zip and importing it through the
// same pipeline as a local folder import — an installed hub skill is just a
// library skill plus a row in the daemon's `hub_skill_installs` table.

/** One catalog entry from the hub, mapped to the fields the UI needs. */
export interface HubSkillSummary {
  /** Unique hub slug — the key for the download endpoint. */
  slug: string;
  name: string;
  /** Chinese description when the hub has one, else the original. */
  description: string;
  version: string;
  downloads: number;
  /** Author handle (the hub namespace owner). */
  ownerName: string;
  /** Hub namespace handle — passed back to the download endpoint when present. */
  namespace?: string;
  category: string;
  /** Author/skill verified by the hub. */
  verified: boolean;
  /** Skill needs an external API key to be useful (labels.requires_api_key). */
  requiresApiKey: boolean;
  updatedAt: number; // epoch ms
  /** Annotated by the daemon: this slug is already installed locally. */
  installed?: boolean;
  /** Version recorded at install/update time (only when installed). */
  installedVersion?: string;
}

export interface HubSkillsQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  category?: string;
}

export interface HubSkillsListResponse {
  skills: HubSkillSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HubCategory {
  key: string;
  name: string;
}

export interface HubCategoriesResponse {
  categories: HubCategory[];
}

export interface InstallHubSkillRequest {
  slug: string;
  version?: string;
  namespace?: string;
}

export interface InstallHubSkillResponse {
  skill: SkillManifestEntry;
  /** True when the slug was already installed and its content was refreshed. */
  updated: boolean;
  /** The version actually installed (read from the downloaded package). */
  version: string;
}
