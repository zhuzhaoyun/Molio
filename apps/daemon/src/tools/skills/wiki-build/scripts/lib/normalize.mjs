'use strict';
/**
 * Line normalization for wiki-build preprocessing.
 *
 * Raw novel dumps frequently arrive as a single huge line (no paragraph
 * breaks), which defeats every line-based tool downstream: grep -n line
 * numbers become meaningless, Read's 2000-line cap covers nothing, and
 * chapter-title segmentation finds no anchors. Normalization restores a
 * line structure WITHOUT changing the text itself:
 *
 *   1. Unify CRLF/CR → LF
 *   2. Insert line breaks before inline segment markers (e.g. a 第X章 that
 *      sits mid-line in a single-line dump) — only for markers the profile
 *      declares in `inlineSplitCores`
 *   3. Split over-long lines at sentence boundaries (。！？；… and closing
 *      quotes), falling back to hard slices when there is no punctuation
 *   4. Collapse blank-line runs, trim trailing whitespace
 *
 * The transcode copy written from these lines is what all later grep /
 * Read / line-referenced evidence gathering operates on, so line numbers
 * in segments.json are stable addresses into it.
 */

/** Hard upper bound for a normalized line (CJK chars). */
const DEFAULT_MAX_LINE_CHARS = 400;
/** Flush an accumulated sentence buffer once it reaches this fraction of max. */
const FLUSH_RATIO = 0.6;
/** Sentence terminator cluster: punctuation + optional closing quotes/brackets. */
const SENTENCE_SPLIT_RE = /([。！？；…]+[”"』」）)]*\s*)/;

/**
 * Insert a newline before every occurrence of the given marker cores that is
 * not already at line start. Cores are regex sources WITHOUT the leading ^
 * anchor (e.g. `第[0-9一二三]+[章节回]`).
 */
function splitInlineMarkers(text, cores) {
  if (!cores || !cores.length) return text;
  const alt = cores.map((c) => `(?:${c})`).join('|');
  // (.) cannot match \n, so this only fires for mid-line markers.
  const re = new RegExp(`(.)(${alt})`, 'g');
  return text.replace(re, (_m, before, marker) => `${before}\n${marker}`);
}

/** Split one over-long line at sentence boundaries; hard slice as fallback. */
function splitLongLine(line, maxLineChars) {
  const parts = line.split(SENTENCE_SPLIT_RE);
  if (parts.length < 3) return hardSlice(line, maxLineChars);

  const out = [];
  let buf = '';
  for (const part of parts) {
    if (!part) continue;
    buf += part;
    if (buf.length >= maxLineChars * FLUSH_RATIO) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf);
  // Any emitted piece can still exceed max (a single sentence) — re-slice those.
  return out.flatMap((piece) =>
    piece.length > maxLineChars ? hardSlice(piece, maxLineChars) : [piece],
  );
}

function hardSlice(line, maxLineChars) {
  const out = [];
  for (let i = 0; i < line.length; i += maxLineChars) {
    out.push(line.slice(i, i + maxLineChars));
  }
  return out;
}

/**
 * Lines that START with a segment marker get their title broken onto its own
 * line (at the first sentence terminator within the leading 60 chars). After
 * splitInlineMarkers, a single-line dump produces "第一章 标题。正文……" chunks;
 * separating the title restores the invariant segment patterns rely on:
 * marker lines are short title-only lines.
 */
function separateTitleLines(lines, markerCore) {
  if (!markerCore) return lines;
  let head;
  try {
    head = new RegExp(`^\\s*(?:${markerCore})`);
  } catch {
    return lines;
  }
  const out = [];
  for (const line of lines) {
    if (!head.test(line)) {
      out.push(line);
      continue;
    }
    const m = line.slice(0, 60).match(/[。！？]/);
    if (m && m.index > 0 && m.index < line.length - 1) {
      out.push(line.slice(0, m.index + 1).replace(/\s+$/u, ''));
      const rest = line.slice(m.index + 1);
      if (rest.trim()) out.push(rest);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Normalize decoded text into a clean line array.
 *
 * @param {string} text decoded file content
 * @param {{ maxLineChars?: number, inlineSplitCores?: string[], titleMarkerCore?: string }} [opts]
 * @returns {string[]} normalized lines (no trailing newlines)
 */
function normalizeLines(text, opts = {}) {
  const maxLineChars = opts.maxLineChars || DEFAULT_MAX_LINE_CHARS;

  let t = text.replace(/\r\n?/g, '\n');
  if (opts.inlineSplitCores && opts.inlineSplitCores.length) {
    t = splitInlineMarkers(t, opts.inlineSplitCores);
  }

  const rawLines = t.split('\n');
  const lines = [];
  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/u, '');
    if (line.length > maxLineChars) {
      for (const piece of splitLongLine(line, maxLineChars)) lines.push(piece);
    } else {
      lines.push(line);
    }
  }
  const titled = separateTitleLines(lines, opts.titleMarkerCore);

  // Collapse runs of 3+ blank lines to a single blank line.
  const collapsed = [];
  let blanks = 0;
  for (const line of titled) {
    if (line === '') {
      blanks++;
      if (blanks <= 1) collapsed.push(line);
    } else {
      blanks = 0;
      collapsed.push(line);
    }
  }
  // Trim leading/trailing blanks.
  while (collapsed.length && collapsed[0] === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed;
}

export { normalizeLines, splitInlineMarkers, splitLongLine, separateTitleLines, DEFAULT_MAX_LINE_CHARS };
