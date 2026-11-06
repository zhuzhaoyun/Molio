/**
 * Wikilink text scanning helpers — TypeScript twin of
 * src/tools/skills/wiki-build/scripts/lib/linktext.mjs.
 *
 * The .mjs side is plain JS because linkpass.mjs / deadcheck.mjs run under
 * bare `node` (spawned by agent CLIs) and cannot import .ts; this side exists
 * because daemon tsc builds without allowJs and cannot import the .mjs.
 * The two MUST stay behavior-identical — test/core/wikilink-text.test.ts
 * runs both over the same fixtures and diffs the results.
 *
 * Rule encoded here: inside fenced code blocks and inline code spans,
 * [[...]] is literal text — it does not render as a link, so it is neither
 * a graph edge (graph.ts) nor a live/dead link (deadcheck.mjs).
 */

export type Interval = [number, number];

/** Does [a0, a1) intersect any [s, e) in list? */
export function intervalOverlaps(a: Interval, list: Interval[]): boolean {
  for (const [s, e] of list) if (a[0] < e && a[1] > s) return true;
  return false;
}

/** Code-only intervals: fenced blocks + inline code. */
export function codeIntervals(content: string): Interval[] {
  const prot: Interval[] = [];

  // Fenced code blocks: line starting with ``` until closing fence.
  const fenceRe = /^[ \t]*```[^\n]*$/gm;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(content)) !== null) {
    if (open === -1) open = m.index;
    else {
      prot.push([open, m.index + m[0].length]);
      open = -1;
    }
  }
  if (open !== -1) prot.push([open, content.length]);

  // Inline code (single line spans).
  for (const im of content.matchAll(/`[^`\n]+`/g)) prot.push([im.index, im.index + im[0].length]);

  return prot;
}
