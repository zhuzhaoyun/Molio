/**
 * SKILL.md primitives — generate and parse the markdown+frontmatter format that
 * runtime CLIs' skill discovery reads. Shared by the daemon (store generate/strip,
 * importer parse) and the web UI (the SKILL.md editor), so the format has a
 * single source of truth.
 *
 * Format (matches the vault-installed skills in apps/daemon/src/tools/skills/):
 *   ---
 *   name: <single line>
 *   description: <single line>
 *   version: 1.0.0
 *   ---
 *
 *   <instructions body>
 */

export interface ParsedSkillMd {
  name: string;
  description: string;
  instructions: string;
}

/** Collapse newlines so name/description stay valid single-line frontmatter values. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

export function generateSkillMd(name: string, description: string, instructions: string): string {
  return (
    `---\n` +
    `name: ${singleLine(name)}\n` +
    `description: ${singleLine(description)}\n` +
    `version: 1.0.0\n` +
    `---\n\n` +
    `${instructions.trim()}\n`
  );
}

/** Strip a leading `---\n...\n---` frontmatter block; returns the body. */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return content;
  return content.slice(match[0].length).replace(/^\r?\n/, '');
}

/**
 * Parse a SKILL.md into { name, description, instructions }.
 * Tolerant of missing fields and of content with no frontmatter at all
 * (in which case the whole text becomes the instructions).
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  const body = stripFrontmatter(content);
  const name = frontmatterField(content, 'name') ?? '';
  const description = frontmatterField(content, 'description') ?? '';
  return { name, description, instructions: body.trim() };
}

/** Read a single `key: value` line from the frontmatter block (null if absent). */
function frontmatterField(content: string, key: string): string | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch || !fmMatch[1]) return null;
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = fmMatch[1].match(re);
  if (!m || m[1] === undefined) return null;
  // Strip surrounding quotes if present.
  return m[1].trim().replace(/^["']|["']$/g, '');
}
