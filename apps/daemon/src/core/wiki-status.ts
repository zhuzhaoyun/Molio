/**
 * Wiki ingest-status derived from the wiki itself (the Agent-maintained truth),
 * NOT from git. Three signals are combined — any match means "ingested":
 *
 * 1. `wiki/sources/<page>.md` frontmatter `sources:` list — each source-summary
 *    page records the original source file(s) it was built from. Page mtime =
 *    ingest time.
 * 2. `wiki/log.md` `| ingest | <filename>` entries + `| build |` coverage.
 * 3. Name-mention fallback: the source's basename appears anywhere in the wiki
 *    text. Catches vaults where the Agent wove sources into concept/entity
 *    pages without a source-summary page.
 *
 * Three states (TreeNode.ingestStatus):
 * - `pending`          — not matched by any signal
 * - `tracked-clean`    — ingested, source mtime <= ingest time
 * - `tracked-modified` — ingested, but source modified since (mtime > ingest time)
 *
 * No git, no Molio state file — legacy vaults work immediately.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TreeNode, IngestStatus } from '@molio/contracts';
// Import from vault-prune (not knowledge) to avoid transitively loading encoding.ts.
import { isPrunedDirName, MAX_DIR_ENTRIES } from './vault-prune.js';

const LOG_REL = path.join('wiki', 'log.md');
const SOURCES_DIR_REL = path.join('wiki', 'sources');

interface ParsedWiki {
  /** normalized key → latest ingest time (ms) */
  ingestedAt: Map<string, number>;
  latestBuildAt: number;
  /** Normalized text of all wiki/*.md — for the name-mention fallback. */
  wikiBlob: string;
  /** Approximate last wiki activity time (ms). */
  wikiActivityAt: number;
}

const cache = new Map<string, { token: string; parsed: ParsedWiki }>();

// ─── public API ───

export async function annotateTreeStatus(vaultPath: string, nodes: TreeNode[]): Promise<void> {
  const logPath = path.join(vaultPath, LOG_REL);
  const sourcesDir = path.join(vaultPath, SOURCES_DIR_REL);
  const logExists = fs.existsSync(logPath);
  const sourcesExist = fs.existsSync(sourcesDir);
  if (!logExists && !sourcesExist) return;

  let parsed: ParsedWiki;
  try {
    parsed = parseCached(vaultPath, logPath, sourcesDir, logExists, sourcesExist);
  } catch {
    return;
  }

  const mentionEnabled = countFiles(nodes) <= MENTION_CAP;
  annotateNodes(nodes, parsed, mentionEnabled);
}

export function invalidateLogCache(vaultPath: string): void {
  cache.delete(vaultPath);
}

// ─── cache + parse (single-pass wiki walk) ───

function parseCached(
  vaultPath: string,
  logPath: string,
  sourcesDir: string,
  logExists: boolean,
  sourcesExist: boolean,
): ParsedWiki {
  const logMtime = logExists ? fs.statSync(logPath).mtimeMs : 0;
  const dirMtime = sourcesExist ? fs.statSync(sourcesDir).mtimeMs : 0;
  const token = `${logMtime}:${dirMtime}`;

  const cached = cache.get(vaultPath);
  if (cached && cached.token === token) return cached.parsed;

  const parsed: ParsedWiki = { ingestedAt: new Map(), latestBuildAt: 0, wikiBlob: '', wikiActivityAt: 0 };
  if (logExists) {
    parseLogContent(fs.readFileSync(logPath, 'utf-8'), parsed);
  }
  // Single-pass wiki walk: build the text blob AND collect sources-page
  // frontmatter in one traversal.  Avoids reading sources pages twice.
  walkWiki(path.join(vaultPath, 'wiki'), parsed);
  parsed.wikiActivityAt = logMtime || dirMtime;

  cache.set(vaultPath, { token, parsed });
  return parsed;
}

/** Walk wiki/**​/*.md — build the normalized blob and collect each sources-page's
 *  frontmatter (page mtime + `sources:` list). */
function walkWiki(wikiDir: string, out: ParsedWiki): void {
  let blob = '';
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.length > MAX_DIR_ENTRIES) return;
    for (const e of entries) {
      if (isPrunedDirName(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        let content: string;
        try { content = fs.readFileSync(p, 'utf-8'); } catch { continue; }
        blob += '\n' + content;
        // If this is a sources-page, extract its frontmatter
        if (d === path.join(wikiDir, 'sources')) {
          collectSourcesPage(p, e.name, content, out);
        }
      }
    }
  };
  walk(wikiDir);
  out.wikiBlob = normalize(blob);
}

function collectSourcesPage(pagePath: string, _name: string, content: string, out: ParsedWiki): void {
  let pageMtime = 0;
  try { pageMtime = fs.statSync(pagePath).mtimeMs; } catch { return; }
  for (const src of extractSourcesList(content)) {
    for (const key of keysFor(src)) {
      record(out.ingestedAt, key, pageMtime);
    }
  }
}

// ─── tree annotation ───

function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.path === 'wiki' || node.path.startsWith('wiki/')) continue;
    if (node.type === 'file') n++;
    else if (node.children) n += countFiles(node.children);
  }
  return n;
}

function annotateNodes(nodes: TreeNode[], parsed: ParsedWiki, mentionEnabled: boolean): IngestStatus | null {
  const order: IngestStatus[] = ['tracked-clean', 'tracked-modified', 'pending'];
  let worst: IngestStatus | null = null;

  for (const node of nodes) {
    if (node.path === 'wiki' || node.path.startsWith('wiki/')) continue;

    if (node.type === 'directory' && node.children) {
      const child = annotateNodes(node.children, parsed, mentionEnabled);
      if (child) { node.ingestStatus = child; worst = pick(worst, child, order); }
      continue;
    }

    if (node.type === 'file') {
      const s = statusForFile(node, parsed, mentionEnabled);
      node.ingestStatus = s;
      worst = pick(worst, s, order);
    }
  }
  return worst;
}

function statusForFile(node: TreeNode, parsed: ParsedWiki, mentionEnabled: boolean): IngestStatus {
  const mtime = node.modifiedAt ?? 0;
  const effectiveAt = matchStrict(node, parsed);

  if (effectiveAt > 0) {
    return mtime > effectiveAt ? 'tracked-modified' : 'tracked-clean';
  }

  // Fallback: name-mention in the wiki blob.
  if (mentionEnabled && parsed.wikiBlob) {
    const n = normalize(stripMd(node.name));
    if (n.length >= MIN_NORMALIZED_LEN && parsed.wikiBlob.includes(n)) {
      return mtime > parsed.wikiActivityAt ? 'tracked-modified' : 'tracked-clean';
    }
  }

  return 'pending';
}

/** Try signals 1+2 (sources: frontmatter + log.md ingest/build).  Returns the
 *  effective ingest time (ms), or 0 if no strict match. */
function matchStrict(node: TreeNode, parsed: ParsedWiki): number {
  let ingestedAt = 0;
  for (const key of fileKeys(node)) {
    const v = parsed.ingestedAt.get(key);
    if (v && v > ingestedAt) ingestedAt = v;
  }
  const buildAt = (parsed.latestBuildAt > 0 && (node.modifiedAt ?? 0) <= parsed.latestBuildAt)
    ? parsed.latestBuildAt : 0;
  return Math.max(ingestedAt, buildAt);
}

function pick(cur: IngestStatus | null, cand: IngestStatus, order: IngestStatus[]): IngestStatus | null {
  if (!cur) return cand;
  return order.indexOf(cand) > order.indexOf(cur) ? cand : cur;
}

// ─── log.md parsing ───

const LOG_ENTRY_RE = /^##\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*\|\s*(\w+)\s*\|\s*(.+?)\s*$/;

function parseLogContent(content: string, out: ParsedWiki): void {
  for (const line of content.split(/\r?\n/)) {
    const m = LOG_ENTRY_RE.exec(line);
    if (!m) continue;
    const [, date, time, op, arg] = m;
    const ts = parseDate(date!, time);
    if (ts === null) continue;

    if (op === 'ingest') {
      for (const key of keysFor(cleanEntry(arg!))) {
        record(out.ingestedAt, key, ts);
      }
    } else if (op === 'build') {
      if (ts > out.latestBuildAt) out.latestBuildAt = ts;
    }
  }
}

// ─── sources: frontmatter extraction ───

function extractSourcesList(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return [];
  const result: string[] = [];
  let inSources = false;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const line = lines[i]!;
    if (/^sources:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources) {
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item) {
        const cleaned = cleanEntry(item[1]!);
        if (cleaned) result.push(cleaned);
      } else if (!/^\s/.test(line) && line.trim() !== '') {
        inSources = false;
      }
    }
  }
  return result;
}

// ─── key normalization ───

function cleanEntry(raw: string): string {
  let s = raw.trim();
  // Strip wrapping layers: wiki-link brackets, double quotes, single quotes.
  // Loop handles nested wraps like `"[[path]]"`.
  for (;;) {
    if (s.startsWith('[[') && s.endsWith(']]')) {
      s = s.slice(2, -2).trim();
    } else if (s.startsWith('"') && s.endsWith('"')) {
      s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    } else if (s.startsWith("'") && s.endsWith("'")) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return s;
}

function stripMd(s: string): string {
  return s.toLowerCase().endsWith('.md') ? s.slice(0, -3) : s;
}

function normalize(s: string): string {
  return stripMd(s.toLowerCase().replace(/\s+/g, '').replace(/["“”'‘’「」『』]/g, ''));
}

const MIN_NORMALIZED_LEN = 8;
const MENTION_CAP = 2000;

/** Produce a set of lookup keys for a source path string. Covers exact match,
 *  exact-without-.md, and normalized — so the Agent can write a path, basename,
 *  wiki-link, or use different spacing/quotes and still match. */
function keysFor(s: string): string[] {
  if (!s) return [];
  const base = path.basename(s);
  return dedup([
    s, stripMd(s), base, stripMd(base),
    ...(normalize(s).length >= MIN_NORMALIZED_LEN ? [normalize(s)] : []),
    ...(normalize(base).length >= MIN_NORMALIZED_LEN ? [normalize(base)] : []),
  ]);
}

function fileKeys(node: TreeNode): string[] {
  return dedup([...keysFor(node.path), ...keysFor(node.name)]);
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function record(map: Map<string, number>, key: string, ts: number): void {
  const prev = map.get(key) ?? 0;
  if (ts > prev) map.set(key, ts);
}

function parseDate(date: string, time?: string): number | null {
  const d = new Date(`${date} ${time ?? '00:00'}`);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}