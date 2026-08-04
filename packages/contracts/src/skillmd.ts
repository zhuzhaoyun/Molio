/**
 * SKILL.md primitives – generate and parse the markdown+frontmatter format that
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
 *
 * Parsing is deliberately tolerant of real-world pastes:
 *   - a BOM / leading blank lines before the opening `---` (Windows editors),
 *   - missing `---` fences entirely – content that starts straight with
 *     `name:` / `description:` / `version:` field lines (platform copies that
 *     lost their fences) is still recognized as frontmatter,
 *   - YAML block scalars (`description: |` + indented lines),
 *   - several fields collapsed onto ONE line (`name: x description: y` —
 *     platform copies that also lost the newlines between field lines).
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

/**
 * Strip a leading frontmatter block and return the body. Handles both a
 * `---\n...\n---` fenced block and (fallback) an unfenced leading field
 * block; see splitFrontmatter.
 */
export function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/**
 * Parse a SKILL.md into { name, description, instructions }.
 * Tolerant of missing fields and of content with no frontmatter at all
 * (in which case the whole text becomes the instructions).
 *
 * Name resolution: frontmatter `name:` first; when absent (users paste plain
 * markdown that never had frontmatter) fall back to the first heading in the
 * body, so creating a skill from pasted content doesn't dead-end on a missing
 * name. The heading line itself stays part of the instructions.
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  const { frontmatter, body } = splitFrontmatter(content);
  const name = (frontmatterField(frontmatter, 'name') ?? '').trim() || firstHeadingText(body);
  const description = frontmatterField(frontmatter, 'description') ?? '';
  return { name, description, instructions: body.trim() };
}

/**
 * Derive a guaranteed-non-empty display name for a NEW skill being created from
 * pasted SKILL.md, so creation NEVER dead-ends on a missing name and never needs
 * a manual name field. (Imports keep their own basename fallbacks – this chain is
 * only for the author-from-content path.) Fallback chain:
 *   1. parsed name (frontmatter `name:` → first heading)
 *   2. description
 *   3. first 10 characters of the content
 *   4. the literal default "skills"
 */
export function deriveSkillName(parsed: ParsedSkillMd): string {
  const name = parsed.name.trim();
  if (name) return name;
  const description = parsed.description.trim();
  if (description) return description;
  const content = parsed.instructions.trim();
  if (content) return firstChars(content, 10);
  return 'skills';
}

/**
 * First `n` characters of a text for use as a name. Counts by Unicode code
 * point (not UTF-16 units) so CJK / emoji don't split mid-character, then
 * collapses inner newlines so the result stays a valid single-line name.
 */
function firstChars(text: string, n: number): string {
  const chars = Array.from(text);
  return singleLine(chars.slice(0, n).join(''));
}

/** Strip a BOM and leading blank lines so frontmatter detection survives Windows pastes. */
function trimLeadingNoise(content: string): string {
  return content.replace(/^﻿/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
}

/** First-line keys that mark an UNfenced frontmatter block (the standard skill fields). */
const KNOWN_FIELD = /^(name|description|version)\s*:/;
/** Any YAML-ish `key:` line. */
const FIELD_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:/;
/** A YAML block-scalar indicator as a whole value: `|`, `|-`, `>+`, … */
const BLOCK_SCALAR = /^[|>][+-]?$/;
/**
 * The point inside a field line where a platform copy jammed the NEXT known
 * field onto the same line (`name: x␣description: y`). Splitting here restores
 * one line per field. Only the known skill keys count as boundaries — a value
 * that happens to contain some other `word:` (e.g. "see: docs") stays intact.
 */
const COLLAPSED_FIELD = /[ \t]+(?=(?:name|description|version)\s*:)/;

/** The value part of a `key: value` line ('' when the line is not a field). */
function fieldValue(line: string): string {
  const m = line.match(FIELD_LINE);
  return m ? line.slice(m[0].length).trim() : '';
}

interface FrontmatterSplit {
  /** The raw field lines (fences excluded); null when no frontmatter detected. */
  frontmatter: string | null;
  body: string;
}

/**
 * Split content into a frontmatter field block and a body. Recognizes, in order:
 *   1. a standard `---\n...\n---` fenced block (tolerant of a BOM / blank lines
 *      before the opening fence and stray spaces after either fence),
 *   2. an UNfenced block: content starting directly with field lines. Only fires
 *      when the first line is a known skill field (`name:` / `description:` /
 *      `version:`), then consumes the contiguous run of `key: value` lines
 *      including indented block-scalar continuations. This covers platform
 *      pastes that lost their `---` fences; without it the name falls through
 *      to the first-10-chars default and yields junk like `name: khaz`.
 *
 * Both paths re-split lines where several known fields were collapsed onto one
 * line (`name: x description: y`, see COLLAPSED_FIELD) — otherwise the first
 * field's value swallows the rest and the later fields go missing.
 */
function splitFrontmatter(content: string): FrontmatterSplit {
  const text = trimLeadingNoise(content);

  const fenced = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fenced && fenced[1] !== undefined) {
    const body = text.slice(fenced[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
    return { frontmatter: expandCollapsedFields(fenced[1]), body };
  }

  const lines = text.split(/\r?\n/);
  if (!lines.length || !KNOWN_FIELD.test(lines[0] ?? '')) {
    return { frontmatter: null, body: text };
  }

  let i = 0;
  const fieldLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!FIELD_LINE.test(line)) break; // a blank line or body text ends the unfenced block
    i += 1;
    // A platform copy may have jammed several fields onto this one line;
    // re-split so each field is read on its own line.
    const parts = line.split(COLLAPSED_FIELD);
    fieldLines.push(...parts);
    const lastValue = fieldValue(parts[parts.length - 1] ?? '');
    if (BLOCK_SCALAR.test(lastValue)) {
      // Swallow the scalar's body: indented lines and (inner) blank lines.
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (next.trim() === '' || /^[ \t]/.test(next)) {
          fieldLines.push(next);
          i += 1;
          continue;
        }
        break;
      }
    }
  }

  const frontmatter = fieldLines.join('\n');
  const body = lines.slice(i).join('\n').replace(/^(?:[ \t]*\r?\n)+/, '');
  return { frontmatter, body };
}

/**
 * Re-split frontmatter lines that a platform copy collapsed onto one line
 * (`name: x description: y` → two lines). Runs on the fenced field block only,
 * never the body. Block-scalar bodies are left untouched: an indented line
 * that merely MENTIONS `name:` is scalar content, not a field.
 */
function expandCollapsedFields(frontmatter: string): string {
  const out: string[] = [];
  let inScalar = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (inScalar && (line.trim() === '' || /^[ \t]/.test(line))) {
      out.push(line); // blank / indented continuation of the scalar above
      continue;
    }
    inScalar = false;
    if (!FIELD_LINE.test(line)) {
      out.push(line);
      continue;
    }
    const parts = line.split(COLLAPSED_FIELD);
    out.push(...parts);
    if (BLOCK_SCALAR.test(fieldValue(parts[parts.length - 1] ?? ''))) inScalar = true;
  }
  return out.join('\n');
}

/**
 * Read a single `key: value` entry from an extracted frontmatter block
 * (null if absent). Understands YAML block scalars (`key: |` + indented
 * lines) and strips surrounding quotes.
 */
function frontmatterField(frontmatter: string | null, key: string): string | null {
  if (!frontmatter) return null;
  const lines = frontmatter.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? '';
    const m = line.match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
    if (!m || m[1] === undefined) continue;
    const raw = m[1].trim();
    if (BLOCK_SCALAR.test(raw)) {
      return readBlockScalar(lines, idx + 1, raw.startsWith('>'));
    }
    // Strip a collapsed block-scalar prefix (`| text` on one line) and quotes.
    return raw.replace(/^[|>][+-]?\s+/, '').replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * Join a block scalar's indented lines: literal `|` keeps newlines, folded `>`
 * joins single newlines with spaces (blank lines stay paragraph breaks).
 */
function readBlockScalar(lines: string[], start: number, folded: boolean): string {
  const parts: string[] = [];
  for (let j = start; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (line.trim() === '') {
      parts.push('');
      continue;
    }
    if (!/^[ \t]/.test(line)) break; // a de-indented line ends the scalar
    parts.push(line.replace(/^[ \t]+/, ''));
  }
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  const joined = parts.join('\n');
  if (!folded) return joined.trim();
  return joined.replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Extract the first markdown heading's text from a body. Skips fenced code
 * blocks (a `# comment` inside a fence is not a title), ignores `#hashtag`
 * lines (ATX headings require whitespace after the hashes), strips optional
 * closing hashes, and cleans inline formatting (links / emphasis / code).
 * Returns '' when no usable heading exists.
 */
function firstHeadingText(body: string): string {
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!m || m[1] === undefined) continue;
    const text = cleanInlineHeading(m[1]);
    if (text) return text;
  }
  return '';
}

/** Strip inline markdown syntax from a heading: `[label](url)` → label, drop emphasis/code marks. */
function cleanInlineHeading(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](url) → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/[*_`~]+/g, '')
    .trim();
}
