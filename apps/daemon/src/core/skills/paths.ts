/**
 * Path helpers for the global user skill library.
 *
 * Source of truth: `~/.molio/skills/<id>/SKILL.md` (library/core content) +
 *                   the daemon's `skills` table (metadata + master switch).
 * Effect (sync):    `<vault>/.claude/skills/molio--<dirName>/SKILL.md` —
 *                   per-vault fan-out driven by vault-config.ts (claudeHome is
 *                   pointed at the vault's `.claude`). dirName is the skill's
 *                   slugified DISPLAY NAME (slugifySkillName below, collisions
 *                   resolved by sync.planSyncTargets), so runtime CLI skill
 *                   lists show readable names instead of DB uuids. The
 *                   `molio--` prefix namespaces Molio-owned skills so we never
 *                   touch the user's own skills.
 * Legacy:           pre-per-vault builds synced to `~/.claude/skills/molio--*`;
 *                   startup cleanup removes those (cleanupLegacyGlobalSync).
 *                   Older per-vault builds used `molio--<uuid>` dir names; to
 *                   the name-based reconcile those are plain orphans and get
 *                   swept automatically — no migration code needed.
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

/**
 * True when `segment` is a single safe path segment (no separators, no
 * `.`/`..`, bounded length). Skill ids AND synced dir names (slugified display
 * names) are interpolated into filesystem paths; enforcing the invariant HERE —
 * the module that owns the path layout — means no caller (DB row, route param,
 * imported filename, user-chosen display name) can ever escape the skills dirs.
 */
export function isValidSkillPathSegment(segment: string): boolean {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment.length <= 128 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    segment === path.basename(segment)
  );
}

/** Throw when `segment` is not a safe path segment (see isValidSkillPathSegment). */
export function assertSafeSkillPathSegment(segment: string): void {
  if (!isValidSkillPathSegment(segment)) {
    throw new Error(`Invalid skill path segment: ${JSON.stringify(segment)}`);
  }
}

/** Max code points of a slugified skill dir name (bounded well under the 128 segment cap). */
const MAX_SLUG_LEN = 64;

/**
 * Slugify a skill's display name into a readable, filesystem-safe dir segment
 * (the part after the `molio--` prefix in synced skill dirs).
 *
 * Rules: NFKC-normalize first (full-width ｖ２ → v2); keep Unicode letters and
 * digits (Chinese names stay readable); lowercase (case-insensitive filesystem
 * parity + runtime naming convention); map every other char to `-`; collapse
 * `-` runs; trim edge `-`; cap at MAX_SLUG_LEN code points.
 *
 * May return '' (e.g. emoji-only names) — callers fall back to an id-derived
 * segment. Every NON-EMPTY output satisfies isValidSkillPathSegment (no
 * separators/dots/spaces survive, so no Windows reserved-name or trailing-dot
 * traps; the molio-- prefix additionally guarantees the full dir name is
 * never a bare reserved word like `con`).
 */
export function slugifySkillName(name: string): string {
  let slug = '';
  for (const ch of name.normalize('NFKC')) {
    if (/^[\p{L}\p{N}]$/u.test(ch)) {
      slug += ch.toLowerCase();
    } else if (slug.length > 0 && !slug.endsWith('-')) {
      slug += '-';
    }
  }
  if (slug.endsWith('-')) slug = slug.slice(0, -1);
  const points = Array.from(slug);
  if (points.length > MAX_SLUG_LEN) {
    slug = points.slice(0, MAX_SLUG_LEN).join('').replace(/-+$/, '');
  }
  return slug;
}

/** `~/.molio/skills` */
export function skillsDir(opts?: SkillPathsOpts): string {
  return path.join(opts?.molioHome ?? defaultMolioHome(), 'skills');
}

/** `~/.molio/skills/<id>` */
export function skillContentDir(id: string, opts?: SkillPathsOpts): string {
  assertSafeSkillPathSegment(id);
  return path.join(skillsDir(opts), id);
}

/** `~/.claude/skills` */
export function claudeSkillsDir(opts?: SkillPathsOpts): string {
  return path.join(opts?.claudeHome ?? defaultClaudeHome(), 'skills');
}

/**
 * `<claudeHome>/skills/molio--<dirName>` — `dirName` is the PLANNED segment
 * for the vault side (slugified display name, see sync.planSyncTargets), NOT
 * a skill id. Library content stays keyed by id under `~/.molio/skills/`.
 */
export function molioSkillDir(dirName: string, opts?: SkillPathsOpts): string {
  assertSafeSkillPathSegment(dirName);
  return path.join(claudeSkillsDir(opts), `${MOLIO_PREFIX}${dirName}`);
}

/** Neutral scratch dir used as cwd for throwaway prefill runs (no project CLAUDE.md leaks in). */
export function scratchDir(opts?: SkillPathsOpts): string {
  return path.join(opts?.molioHome ?? defaultMolioHome(), 'scratch');
}
