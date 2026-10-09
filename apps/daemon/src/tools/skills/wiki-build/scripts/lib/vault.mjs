// lib/vault.mjs — vault-wide scans and attachment resolution shared by
// deadcheck.mjs and media.mjs.
//
// Single home for two things that would otherwise be written twice and drift:
//  1. "what files are in this vault" (pages, images)
//  2. "does this attachment reference point at a real file"
//
// The resolution rule deliberately mirrors what the daemon does for
// /raw/* (core/knowledge.ts resolveWithFallbacks) and what Obsidian does for
// `![[file.png]]`: an exact vault-root-relative path wins, otherwise a
// vault-wide filename lookup. Getting this wrong in one script but not the
// other means a reference can pass the build gate and still 404 in the viewer.

import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_EXT, ATTACHMENT_EXT } from './linktext.mjs';

/** All .md pages under wiki/, as forward-slash paths relative to wiki/. */
export function collectMdPages(vault) {
  const pages = [];
  walk(path.join(vault, 'wiki'), '', (rp, name) => {
    if (name.endsWith('.md')) pages.push(rp);
  });
  return pages;
}

/** All image files under wiki/, as forward-slash paths relative to wiki/. */
export function collectImages(vault) {
  const images = [];
  walk(path.join(vault, 'wiki'), '', (rp, name) => {
    if (IMAGE_EXT.test(name)) images.push(rp);
  });
  return images;
}

/** Attachment paths remain wiki-relative, including ../attachments/. */
export function collectAttachments(vault) {
  const files = [];
  walk(vault, '', (rp, name) => {
    if (ATTACHMENT_EXT.test(name)) files.push(path.posix.relative('wiki', rp));
  });
  return files;
}

function walk(dir, rel, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory is not this function's problem to report
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rp = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rp, onFile);
    else if (e.isFile()) onFile(rp, e.name);
  }
}

/**
 * Build the lookup structures `resolveAttachment` needs.
 * byBaseKey maps a lowercase basename to EVERY path with that name, so an
 * ambiguous bare-name reference can be reported instead of silently picking
 * whichever file the directory walk happened to reach first.
 */
export function buildImageIndex(images) {
  const byPath = new Map(images.map(rel => [path.posix.normalize(`wiki/${rel}`).toLowerCase(), rel]));
  const byBase = new Map();
  for (const rel of images) {
    const b = path.basename(rel).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(rel);
  }
  return { byBase, byPath };
}

/**
 * Resolve one attachment reference. Returns:
 *   { status: 'ok',        resolved }  — points at a real file
 *   { status: 'ambiguous', hits }      — bare name matching several files
 *   { status: 'missing' }              — nothing matches
 */
export function resolveAttachment(target, index) {
  const norm = String(target).trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!norm) return { status: 'missing' };
  // Try vault-root and wiki-relative paths before bare-filename lookup.
  const clean = path.posix.normalize(norm);
  if (clean === '..' || clean.startsWith('../') || path.posix.isAbsolute(clean)) return { status: 'missing' };
  for (const candidate of [clean, `wiki/${clean}`]) {
    const resolved = index.byPath.get(candidate.toLowerCase());
    if (resolved !== undefined) return { status: 'ok', resolved };
  }
  // Match the daemon: only bare names get a vault-wide filename fallback.
  if (clean.includes('/')) return { status: 'missing' };
  const hits = index.byBase.get(path.basename(norm).toLowerCase());
  if (hits && hits.length === 1) return { status: 'ok', resolved: hits[0] };
  if (hits && hits.length > 1) {
    // A reference that pins down one of the same-named files is not ambiguous;
    // only a bare filename is.
    return { status: 'ambiguous', hits: hits.length };
  }
  return { status: 'missing' };
}
