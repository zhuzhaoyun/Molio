/**
 * Wiki ingest-status derived from the wiki itself (the Agent-maintained truth),
 * NOT from git. Two signals are combined — either match means "ingested":
 *
 * 1. `wiki/sources/<page>.md` frontmatter `sources:` list — each source-summary
 *    page records the original source file(s) it was built from. Reliable when
 *    present (the Agent writes explicit paths/filenames). Page mtime = ingest
 *    time for staleness.
 * 2. `wiki/log.md` `| ingest | <filename>` entries — the per-file ingest log.
 *    Reliable when the Agent writes actual filenames (it sometimes writes
 *    descriptions instead, which is why signal 1 is also needed).
 *    `| build |` entries cover all sources unmodified since build.
 *
 * Three states (TreeNode.ingestStatus):
 * - `pending`          — not matched by any signal
 * - `tracked-clean`    — ingested, source mtime <= ingest time
 * - `tracked-modified` — ingested, but source modified since (mtime > ingest time)
 *
 * mtime (not content hash) is used for staleness: any write updates mtime, so
 * same-length edits are caught. No git, no Molio state file — legacy vaults
 * work immediately, and Molio doesn't touch the user's version control.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TreeNode, IngestStatus } from '@molio/contracts';

const LOG_REL = path.join('wiki', 'log.md');
const SOURCES_DIR_REL = path.join('wiki', 'sources');

interface ParsedWiki {
  /** normalized key (path or basename, with/without .md) → latest ingest time (ms) */
  ingestedAt: Map<string, number>;
  /** latest `| build |` timestamp (ms), or 0. */
  latestBuildAt: number;
  /** Normalized text of all wiki/*.md concatenated — for name-mention fallback. */
  wikiBlob: string;
  /** Approximate last wiki activity time (ms), used as ingest time for mentions. */
  wikiActivityAt: number;
}

const cache = new Map<string, { token: string; parsed: ParsedWiki }>();

/**
 * Annotate a scanned tree with `ingestStatus`. Reads wiki/log.md +
 * wiki/sources/*.md (cached). Leaves the tree untouched if the vault has
 * neither (wiki not used yet → no badges).
 */
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

  // The name-mention fallback does a substring search per pending file; cap it
  // for very large vaults to keep tree refreshes fast. (Strict signals still run.)
  const sourceCount = countFiles(nodes);
  const mentionEnabled = sourceCount <= MENTION_CAP;
  annotateNodes(nodes, parsed, mentionEnabled);
}

function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.path === 'wiki' || node.path.startsWith('wiki/')) continue;
    if (node.type === 'file') n++;
    else if (node.children) n += countFiles(node.children);
  }
  return n;
}

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
  if (sourcesExist) {
    parseSourcesPages(sourcesDir, parsed);
  }
  // Build the wiki text blob for the name-mention fallback. wikiActivityAt
  // ≈ last wiki op (log.md mtime, since every ingest/build touches it).
  parsed.wikiBlob = buildWikiBlob(path.join(vaultPath, 'wiki'));
  parsed.wikiActivityAt = logMtime || dirMtime;

  cache.set(vaultPath, { token, parsed });
  return parsed;
}

/** Concatenate + normalize all wiki/*.md content for substring name matching. */
function buildWikiBlob(wikiDir: string): string {
  let blob = '';
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          blob += '\n' + fs.readFileSync(p, 'utf-8');
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(wikiDir);
  return normalize(blob);
}

// ─── Tree annotation ───

function annotateNodes(nodes: TreeNode[], parsed: ParsedWiki, mentionEnabled: boolean): IngestStatus | null {
  const rollupOrder: IngestStatus[] = ['tracked-clean', 'tracked-modified', 'pending'];
  let rollup: IngestStatus | null = null;

  for (const node of nodes) {
    if (node.path === 'wiki' || node.path.startsWith('wiki/')) continue; // products, not sources

    if (node.type === 'directory' && node.children) {
      const child = annotateNodes(node.children, parsed, mentionEnabled);
      if (child) {
        node.ingestStatus = child;
        rollup = pick(rollup, child, rollupOrder);
      }
      continue;
    }

    if (node.type === 'file') {
      node.ingestStatus = statusForFile(node, parsed, mentionEnabled);
      rollup = pick(rollup, node.ingestStatus, rollupOrder);
    }
  }

  return rollup;
}

/**
 * Status for one source file. Uses only `node.modifiedAt` + map lookups —
 * zero extra I/O, so annotation is O(N) Map lookups even at 10k+ files.
 */
function statusForFile(node: TreeNode, parsed: ParsedWiki, mentionEnabled: boolean): IngestStatus {
  const mtime = node.modifiedAt ?? 0;
  let ingestedAt = 0;
  for (const key of fileKeys(node)) {
    const v = parsed.ingestedAt.get(key);
    if (v && v > ingestedAt) ingestedAt = v;
  }
  const buildAt = (parsed.latestBuildAt > 0 && mtime <= parsed.latestBuildAt)
    ? parsed.latestBuildAt
    : 0;
  let effectiveAt = Math.max(ingestedAt, buildAt);

  // Fallback: if no explicit record, check whether the source's name appears
  // anywhere in the wiki text. Catches sources the Agent wove into
  // concept/entity pages without a source-summary page. Guarded by min length
  // to avoid generic-name false positives. Skipped for very large vaults.
  if (mentionEnabled && effectiveAt === 0 && parsed.wikiBlob) {
    for (const key of mentionKeys(node)) {
      if (key && parsed.wikiBlob.includes(key)) {
        effectiveAt = parsed.wikiActivityAt;
        break;
      }
    }
  }

  if (effectiveAt === 0) return 'pending';
  return mtime > effectiveAt ? 'tracked-modified' : 'tracked-clean';
}

/** Distinctive normalized name fragments to search for in the wiki blob. */
function mentionKeys(node: TreeNode): string[] {
  const name = stripMd(node.name);
  const n = normalize(name);
  return n.length >= MIN_NORMALIZED_LEN ? [n] : [];
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
      // arg is the source filename (may include a path prefix); index by
      // basename + full, with/without .md, so fuzzy source files can match.
      for (const key of entryKeys(arg!)) {
        record(out.ingestedAt, key, ts);
      }
    } else if (op === 'build') {
      if (ts > out.latestBuildAt) out.latestBuildAt = ts;
    }
    // other ops (create / split / maintain / lint / save) don't enumerate sources
  }
}

// ─── wiki/sources/*.md frontmatter parsing ───

/**
 * For each source-summary page, read its `sources:` frontmatter list and
 * record each listed source file → page mtime (ingest time).
 */
function parseSourcesPages(sourcesDir: string, out: ParsedWiki): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const pagePath = path.join(sourcesDir, entry.name);
    let pageMtime = 0;
    let content: string;
    try {
      const st = fs.statSync(pagePath);
      pageMtime = st.mtimeMs;
      content = fs.readFileSync(pagePath, 'utf-8');
    } catch {
      continue;
    }
    for (const src of extractSourcesList(content)) {
      for (const key of entryKeys(src)) {
        record(out.ingestedAt, key, pageMtime);
      }
    }
  }
}

/**
 * Extract the `sources:` YAML list from frontmatter. Returns cleaned entries
 * (wiki-link brackets and quotes stripped). Lenient — not a full YAML parser.
 */
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
        // dedented non-list line → sources list ended
        inSources = false;
      }
    }
  }
  return result;
}

// ─── key normalization & matching ───

/**
 * Strip wiki-link brackets and surrounding quotes from a sources: list item,
 * and unescape YAML double-quote escapes (`\"` → `"`, `\\` → `\`). The Agent
 * often wraps source paths in double quotes with escaped inner quotes
 * (filenames containing `"`), which would otherwise leave stray backslashes
 * that break matching.
 */
function cleanEntry(raw: string): string {
  let s = raw.trim();
  // Wiki link: [[...]]
  if (s.startsWith('[[') && s.endsWith(']]')) {
    s = s.slice(2, -2);
  } else if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  } else if (s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

/** Drop a single trailing `.md` (wiki links often omit it). */
function stripMd(s: string): string {
  return s.toLowerCase().endsWith('.md') ? s.slice(0, -3) : s;
}

/**
 * Aggressive normalization for fuzzy matching: lowercase + strip all
 * whitespace + strip quote chars (straight + curly/fullwidth) + drop trailing
 * .md. Catches cases where the Agent recorded a source path with different
 * spacing or quote styling than the actual filename
 * (e.g. "深度解析LLM Wiki" vs "深度解析 LLM Wiki", or straight `"` vs curly `“`).
 * Guarded by a min length so short normalized forms don't cause false positives.
 */
function normalize(s: string): string {
  const n = s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/["'“”‘’「」『』]/g, '');
  return stripMd(n);
}

const MIN_NORMALIZED_LEN = 8;
/** Above this source count, skip the name-mention fallback (substring search)
 * to keep tree refreshes fast. Strict signals still run. */
const MENTION_CAP = 2000;

/** Add a normalized key only if it's long enough to be specific. */
function maybeNormalized(s: string): string[] {
  const n = normalize(s);
  return n.length >= MIN_NORMALIZED_LEN ? [n] : [];
}

/**
 * Index keys for a sources: entry or log arg: the full string and its basename,
 * each with and without trailing .md, plus a normalized form. Lets a source
 * file match whether the Agent wrote a path, a basename, a wiki-link-without-.md,
 * or used different spacing.
 */
function entryKeys(entry: string): string[] {
  const cleaned = cleanEntry(entry);
  if (!cleaned) return [];
  const base = path.basename(cleaned);
  return dedup([
    cleaned, stripMd(cleaned), base, stripMd(base),
    ...maybeNormalized(cleaned), ...maybeNormalized(base),
  ]);
}

/** Lookup keys for a source file node: its path and basename, ±.md, + normalized. */
function fileKeys(node: TreeNode): string[] {
  return dedup([
    node.path, stripMd(node.path), node.name, stripMd(node.name),
    ...maybeNormalized(node.path), ...maybeNormalized(node.name),
  ]);
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

/** Drop the cached parse for a vault. */
export function invalidateLogCache(vaultPath: string): void {
  cache.delete(vaultPath);
}
