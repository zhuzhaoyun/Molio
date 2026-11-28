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
/** Max bytes to read from a wiki/sources/*.md header when extracting YAML frontmatter. */
const FRONTMATTER_READ_BYTES = 16 * 1024;
/** Guards for the legacy name-mention blob fallback so giant generated wikis never stall tree scans. */
const MAX_WIKI_BLOB_FILES = 1500;
const MAX_WIKI_BLOB_FILE_BYTES = 512 * 1024;

interface ParsedWiki {
  /** normalized key → latest ingest time (ms) */
  ingestedAt: Map<string, number>;
  latestBuildAt: number;
  /** Normalized text of wiki/*.md — populated lazily only when strict signals miss. */
  wikiBlob: string;
  wikiBlobLoaded: boolean;
  /** Approximate last wiki activity time (ms). */
  wikiActivityAt: number;
}

const cache = new Map<string, { token: string; parsed: ParsedWiki }>();

// ─── public API ───

export async function annotateTreeStatus(vaultPath: string, nodes: TreeNode[]): Promise<void> {
  // Fast exit: annotateNodes skips the entire `wiki/` subtree (wiki pages are
  // products, not ingest sources). Ready-made / pure-wiki vaults have 0 non-wiki
  // files — skip all disk stats and wiki reads immediately.
  const nonWikiCount = countFiles(nodes);
  if (nonWikiCount === 0) return;

  const logPath = path.join(vaultPath, LOG_REL);
  const sourcesDir = path.join(vaultPath, SOURCES_DIR_REL);
  const logExists = fs.existsSync(logPath);
  const sourcesExist = fs.existsSync(sourcesDir);
  if (!logExists && !sourcesExist) return;

  let parsed: ParsedWiki;
  try {
    parsed = parseStrictCached(vaultPath, logPath, sourcesDir, logExists, sourcesExist);
  } catch {
    return;
  }

  const mentionEnabled = nonWikiCount <= MENTION_CAP;
  if (mentionEnabled && !parsed.wikiBlobLoaded && hasUnmatchedSource(nodes, parsed)) {
    ensureWikiBlob(vaultPath, parsed);
  }
  annotateNodes(nodes, parsed, mentionEnabled);
}

export function invalidateLogCache(vaultPath: string): void {
  cache.delete(vaultPath);
}

// ─── cache + two-stage parse (strict frontmatter/log first, lazy wiki blob fallback) ───

function parseStrictCached(
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

  const parsed: ParsedWiki = {
    ingestedAt: new Map(),
    latestBuildAt: 0,
    wikiBlob: '',
    wikiBlobLoaded: false,
    wikiActivityAt: logMtime || dirMtime,
  };
  if (logExists) {
    parseLogContent(fs.readFileSync(logPath, 'utf-8'), parsed);
  }
  if (sourcesExist) {
    collectSourcesDirFrontmatter(sourcesDir, parsed);
  }

  cache.set(vaultPath, { token, parsed });
  return parsed;
}

/** Read only the frontmatter header of each wiki/sources/*.md (page mtime + `sources:` list). */
function collectSourcesDirFrontmatter(sourcesDir: string, out: ParsedWiki): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.length > MAX_DIR_ENTRIES) return;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || isPrunedDirName(e.name)) continue;
    const p = path.join(sourcesDir, e.name);
    let pageMtime = 0;
    let head = '';
    let fd: number | undefined;
    try {
      fd = fs.openSync(p, 'r');
      const st = fs.fstatSync(fd);
      pageMtime = st.mtimeMs;
      const len = Math.min(FRONTMATTER_READ_BYTES, st.size);
      if (len > 0) {
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = fs.readSync(fd, buf, 0, len, 0);
        head = buf.toString('utf-8', 0, bytesRead);
      }
    } catch {
      continue;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    for (const src of extractSourcesList(head)) {
      for (const key of keysFor(src)) {
        record(out.ingestedAt, key, pageMtime);
      }
    }
  }
}

function hasUnmatchedSource(nodes: TreeNode[], parsed: ParsedWiki): boolean {
  for (const node of nodes) {
    if (node.path === 'wiki' || node.path.startsWith('wiki/')) continue;
    if (node.type === 'directory' && node.children) {
      if (hasUnmatchedSource(node.children, parsed)) return true;
      continue;
    }
    if (node.type === 'file') {
      if (matchStrict(node, parsed) === 0 && normalize(stripMd(node.name)).length >= MIN_NORMALIZED_LEN) {
        return true;
      }
    }
  }
  return false;
}

function ensureWikiBlob(vaultPath: string, out: ParsedWiki): void {
  out.wikiBlobLoaded = true;
  const wikiDir = path.join(vaultPath, 'wiki');
  const chunks: string[] = [];
  let filesRead = 0;
  const walk = (d: string) => {
    if (filesRead >= MAX_WIKI_BLOB_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.length > MAX_DIR_ENTRIES) return;
    for (const e of entries) {
      if (filesRead >= MAX_WIKI_BLOB_FILES) return;
      if (isPrunedDirName(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const st = fs.statSync(p);
          if (st.size > MAX_WIKI_BLOB_FILE_BYTES) continue;
          chunks.push(fs.readFileSync(p, 'utf-8'));
          filesRead++;
        } catch {
          continue;
        }
      }
    }
  };
  walk(wikiDir);
  out.wikiBlob = chunks.length > 0 ? normalize(chunks.join('\n')) : '';
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