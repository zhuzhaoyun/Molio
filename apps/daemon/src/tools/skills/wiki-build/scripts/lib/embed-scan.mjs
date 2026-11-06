// lib/embed-scan.mjs — the one ![[embed]] / ![](markdown image) scanner.
//
// deadcheck.mjs and media.mjs both need "every image/attachment reference in
// every wiki page, resolved against the files on disk". They used to carry
// two hand-rolled copies of the same loop (per-line regex + code-span
// skipping + line numbers + resolveAttachment), and media's copy handled
// standard-markdown images while deadcheck's did not — that asymmetry is
// how drift starts. One scanner now; the two callers keep only what is
// genuinely theirs — the reporting policy and the exit code:
//
//   deadcheck : missing/ambiguous ![[embeds]] are a FAIL (exit 1 gate)
//   media     : the same two buckets FAIL (exit 3), plus referenced→orphan
//               report and markdown-image sites (NOTE, not a gate)
//
// Aggregation is case-insensitive (keyed by lowercased target): resolution
// itself is case-insensitive, so [[Foo.png]] and [[foo.png]] failing
// together as ONE entry is the truthful report. The first-seen raw form is
// kept in `target` for display.

import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXT, ATTACHMENT_EXT, embedRe, codeIntervals, overlaps, lineStartsOf } from './linktext.mjs';
import { resolveAttachment } from './vault.mjs';

// Standard Markdown image ![alt](src). Factory, not a shared instance: /g
// regex carries mutable lastIndex — see linktext.mjs for the full story.
export const mdImgRe = () => /!\[([^\]]*)\]\(\s*(<[^>\n]+>|(?:\\.|[^()\n\\]|\((?:\\.|[^()\\])*\))+?)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)/g;

// Remote/API destinations are not vault files — they cannot dangle.
const REMOTE_SRC_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i;

/** Unwrap <>-quoting, percent-decode, un-backslash a Markdown image path. */
export function decodeImagePath(src) {
  let value = src.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  try { value = decodeURIComponent(value); } catch { /* literal percent */ }
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
}

/**
 * Scan every wiki page for image/attachment references.
 *
 * @param {{ vault: string, rels: string[], index: object }} opts
 *   rels  — page paths relative to wiki/ (lib/vault.mjs collectMdPages)
 *   index — buildImageIndex(collectAttachments(vault))
 * @returns {{
 *   embedOccurrences: number,
 *   missing: Map<string, {target, reason: 'missing', hits: 0, files: {file,line}[]}>,
 *   ambiguous: Map<string, {target, reason: 'ambiguous', hits: number, files: {file,line}[]}>,
 *   referenced: Set<string>,       // wiki-relative paths an embed resolved to
 *   markdownImageSites: {target, status, file, line}[],
 * }}
 */
export function scanEmbeds({ vault, rels, index }) {
  const missing = new Map();
  const ambiguous = new Map();
  const referenced = new Set();
  const markdownImageSites = [];
  let embedOccurrences = 0;

  for (const rel of rels) {
    let content;
    try { content = fs.readFileSync(path.join(vault, 'wiki', rel), 'utf8'); } catch { continue; }
    // Inside a code fence or inline code, `![[图.png]]` is literal TEXT, not
    // a reference — e.g. this skill's own pages documenting the syntax, or a
    // page quoting a broken example. Same rule deadcheck and the graph apply
    // to [[wikilinks]]; a checker that forgot it would fail the build over
    // its own documentation.
    const code = codeIntervals(content);
    const lines = content.split('\n');
    const starts = lineStartsOf(content);
    lines.forEach((ln, i) => {
      const lineStart = starts[i];
      for (const em of ln.matchAll(embedRe())) {
        const target = em[1].trim();
        // Only attachments are this scanner's business; [[页面]] is deadcheck's.
        if (!ATTACHMENT_EXT.test(target)) continue;
        if (overlaps([lineStart + em.index, lineStart + em.index + em[0].length], code)) continue;
        embedOccurrences++;
        const r = resolveAttachment(target, index);
        if (r.status === 'ok') { referenced.add(r.resolved); continue; }
        const bucket = r.status === 'ambiguous' ? ambiguous : missing;
        const key = target.toLowerCase();
        if (!bucket.has(key)) bucket.set(key, { target, reason: r.status, hits: r.hits ?? 0, files: [] });
        bucket.get(key).files.push({ file: `wiki/${rel}`, line: i + 1 });
      }
      // Standard Markdown images resolve relative to this note, as in the UI.
      for (const mm of ln.matchAll(mdImgRe())) {
        const src = decodeImagePath(mm[2]);
        if (REMOTE_SRC_RE.test(src)) continue;
        if (!IMAGE_EXT.test(src)) continue;
        if (overlaps([lineStart + mm.index, lineStart + mm.index + mm[0].length], code)) continue;
        const cleaned = src.replace(/\\/g, '/');
        const target = cleaned.startsWith('/') ? cleaned.replace(/^\/+/, '')
          : path.posix.join('wiki', path.posix.dirname(rel), cleaned);
        const r = resolveAttachment(target, index);
        if (r.status === 'ok') referenced.add(r.resolved);
        markdownImageSites.push({ target: src, status: r.status, file: `wiki/${rel}`, line: i + 1 });
      }
    });
  }

  return { embedOccurrences, missing, ambiguous, referenced, markdownImageSites };
}
