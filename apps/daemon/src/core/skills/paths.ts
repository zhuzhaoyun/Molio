/**
 * Path helpers for the global user skill library.
 *
 * Source of truth: `~/.molio/skills/<id>/SKILL.md` + `manifest.json`.
 * Effect (sync):    `~/.claude/skills/molio--<id>/SKILL.md` — the `molio--`
 *                   prefix namespaces Molio-owned skills so we never touch the
 *                   user's own skills living in `~/.claude/skills/`.
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

/** `~/.molio/skills/manifest.json` */
export function manifestPath(opts?: SkillPathsOpts): string {
  return path.join(skillsDir(opts), 'manifest.json');
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
