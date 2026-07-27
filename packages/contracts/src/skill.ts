/**
 * Skills shared types — the user-managed global skill library.
 *
 * Molio stores skills under `~/.molio/skills/<id>/SKILL.md` (+ manifest.json)
 * and syncs the enabled ones to `~/.claude/skills/molio--<id>/` so the Claude
 * Code runtime auto-discovers them. These types describe the manifest entry and
 * the /api/skills request/response shapes.
 */

export interface SkillManifestEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** True for Molio-shipped curated skills (seeded on startup, cannot be deleted). */
  builtIn: boolean;
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
