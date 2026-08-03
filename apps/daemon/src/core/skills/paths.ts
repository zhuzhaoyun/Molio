/**
 * Path helpers for the global user skill library.
 *
 * Source of truth: `~/.molio/skills/<id>/SKILL.md` (library/core content) +
 *                   the daemon's `skills` table (metadata + master switch).
 * Effect (sync):    `<vault>/.claude/skills/molio--<id>/SKILL.md` — per-vault
 *                   fan-out driven by vault-config.ts (claudeHome is pointed at
 *                   the vault's `.claude`). The `molio--` prefix namespaces
 *                   Molio-owned skills so we never touch the user's own skills.
 * Legacy:           pre-per-vault builds synced to `~/.claude/skills/molio--*`;
 *                   startup cleanup removes those (cleanupLegacyGlobalSync).
 *
 * Every helper accepts optional `molioHome` / `claudeHome` overrides so tests
 * can point them at temp directories (no HOME monkey-patching needed).
 */
import os from 'node:os';
import path from 'node:path';

export interface SkillPathsOpts {
  molioHome?: string;
  claudeHome?: string;
}

/** Prefix for Molio-managed skill folders inside `~/.claude/skills/`. */
export const MOLIO_PREFIX = 'molio--';

export function defaultMolioHome(): string {
  return path.join(os.homedir(), '.molio');
}

export function defaultClaudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

/** `~/.molio/skills` */
export function skillsDir(opts?: SkillPathsOpts): string {
  return path.join(opts?.molioHome ?? defaultMolioHome(), 'skills');
}

/** `~/.molio/skills/<id>` */
export function skillContentDir(id: string, opts?: SkillPathsOpts): string {
  return path.join(skillsDir(opts), id);
}

/** `~/.claude/skills` */
export function claudeSkillsDir(opts?: SkillPathsOpts): string {
  return path.join(opts?.claudeHome ?? defaultClaudeHome(), 'skills');
}

/** `~/.claude/skills/molio--<id>` */
export function molioSkillDir(id: string, opts?: SkillPathsOpts): string {
  return path.join(claudeSkillsDir(opts), `${MOLIO_PREFIX}${id}`);
}

/** Neutral scratch dir used as cwd for throwaway prefill runs (no project CLAUDE.md leaks in). */
export function scratchDir(opts?: SkillPathsOpts): string {
  return path.join(opts?.molioHome ?? defaultMolioHome(), 'scratch');
}
