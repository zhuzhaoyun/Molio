import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { codeIntervals, intervalOverlaps } from '../wikilink-text.js';
import type { PublicAsset, PublicGraph } from '@molio/contracts';

export interface PublicationDraftAsset {
  id: string;
  sourcePath: string;
  contentType: PublicAsset['contentType'];
  bytes: Buffer;
}

export interface PublicationDraftPage {
  id: string;
  sourcePath: string;
  title: string;
  sourceMarkdown: string;
  projectMarkdown: string;
  markdown: string;
  assets: PublicationDraftAsset[];
  warnings: string[];
}

export interface PublicationDraft {
  vaultId: string;
  pages: PublicationDraftPage[];
  graph: PublicGraph;
  totalBytes: number;
  warnings: string[];
}

export interface PublicationSourcePage {
  id: string;
  sourcePath: string;
  sourceMarkdown: string;
  projectMarkdown?: string;
  title?: string;
  assets?: PublicationDraftAsset[];
  warnings?: string[];
}

export interface PublicationLimits {
  maxPages: number;
  maxGraphEdges: number;
  maxMarkdownBytes: number;
  maxAssetsPerPage: number;
  maxAssetBytes: number;
  maxRevisionBytes: number;
}

export interface PublicationReadBudget {
  remainingBytes: number;
  assetsByDigest: Map<string, PublicationDraftAsset>;
}

export const DEFAULT_PUBLICATION_LIMITS: PublicationLimits = {
  maxPages: 1000,
  maxGraphEdges: 20_000,
  maxMarkdownBytes: 512 * 1024,
  maxAssetsPerPage: 50,
  maxAssetBytes: 8 * 1024 * 1024,
  maxRevisionBytes: 48 * 1024 * 1024,
};

const IMAGE_TYPES: Record<string, PublicationDraftAsset['contentType']> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

function matchesImageSignature(bytes: Buffer, type: PublicationDraftAsset['contentType']): boolean {
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/gif') return bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a');
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export function readPublicationSource(
  vaultPath: string,
  sourcePath: string,
  id: string,
  assetIdFor: (realSourcePath: string, digest: string) => string,
  limits: PublicationLimits = DEFAULT_PUBLICATION_LIMITS,
  budget?: PublicationReadBudget,
): PublicationSourcePage {
  if (!sourcePath.startsWith('wiki/') || !sourcePath.toLowerCase().endsWith('.md') || sourcePath.includes('\\')) {
    throw new Error('Publication pages must be Markdown files under wiki/');
  }
  const root = realpathSync(vaultPath);
  const requested = resolve(root, ...sourcePath.split('/'));
  const realPage = realpathSync(requested);
  const realRelative = relative(root, realPage).split(sep).join('/');
  if (realRelative.startsWith('../') || realRelative === '..' || isAbsolute(realRelative) || !realRelative.startsWith('wiki/') || !realRelative.toLowerCase().endsWith('.md')) {
    throw new Error('Wiki source path escapes the Wiki directory');
  }
  const pageStat = statSync(realPage);
  if (!pageStat.isFile()) throw new Error('Wiki source is not a file');
  if (pageStat.size > limits.maxMarkdownBytes) throw new Error(`Page exceeds ${limits.maxMarkdownBytes} bytes: ${sourcePath}`);
  if (budget && pageStat.size > budget.remainingBytes) throw new Error(`Publication exceeds ${limits.maxRevisionBytes} bytes`);
  const pageBytes = readFileSync(realPage);
  if (pageBytes.length > limits.maxMarkdownBytes) throw new Error(`Page exceeds ${limits.maxMarkdownBytes} bytes: ${sourcePath}`);
  if (budget && pageBytes.length > budget.remainingBytes) throw new Error(`Publication exceeds ${limits.maxRevisionBytes} bytes`);
  if (budget) budget.remainingBytes -= pageBytes.length;
  const sourceMarkdown = pageBytes.toString('utf8');
  const parsedOriginal = parseTitleAndBody(sourcePath, sourceMarkdown);
  let projectMarkdown = parsedOriginal.body;
  const warnings: string[] = [];
  const assets: PublicationDraftAsset[] = [];
  const intervals = codeIntervals(projectMarkdown);
  const assetReferences = new Map<string, string>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const imagePattern = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(projectMarkdown)) !== null) {
    const range: [number, number] = [match.index, match.index + match[0].length];
    if (intervalOverlaps(range, intervals)) continue;
    const rawUrl = (match[2] ?? '').replace(/^<|>$/g, '');
    const alt = (match[1] ?? '').replace(/[\[\]]/g, '');
    let asset: PublicationDraftAsset | undefined;
    try {
      if (!rawUrl || /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) || rawUrl.startsWith('//') || rawUrl.startsWith('/') || rawUrl.includes('\\')) {
        throw new Error('remote or absolute image URL is not allowed');
      }
      const decoded = decodeURIComponent(rawUrl.split(/[?#]/, 1)[0] ?? '');
      const lexical = resolve(root, dirname(sourcePath), decoded);
      const candidate = realpathSync(lexical);
      const assetSourcePath = relative(root, candidate).split(sep).join('/');
      if (assetSourcePath.startsWith('../') || assetSourcePath === '..' || isAbsolute(assetSourcePath)) throw new Error('image path escapes the vault');
      const ext = basename(candidate).includes('.') ? `.${basename(candidate).split('.').pop()!.toLowerCase()}` : '';
      const contentType = IMAGE_TYPES[ext];
      if (!contentType) throw new Error('image type is not allowed');
      const stat = statSync(candidate);
      if (!stat.isFile()) throw new Error('image source is not a file');
      if (stat.size > limits.maxAssetBytes) throw new Error(`image exceeds ${limits.maxAssetBytes} bytes`);
      if (!assetReferences.has(assetSourcePath)) {
        // Stage at most one size-limited image to detect duplicates before charging it.
        const bytes = readFileSync(candidate);
        if (bytes.length > limits.maxAssetBytes) throw new Error(`image exceeds ${limits.maxAssetBytes} bytes`);
        if (!matchesImageSignature(bytes, contentType)) throw new Error('image extension and file signature do not match');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const existing = budget?.assetsByDigest.get(digest);
        if (budget && !existing && bytes.length > budget.remainingBytes) throw new Error(`Publication exceeds ${limits.maxRevisionBytes} bytes`);
        const assetId = existing?.id ?? assetIdFor(assetSourcePath, digest);
        const newForPage = !assets.some(existingAsset => existingAsset.id === assetId);
        if (newForPage && assets.length >= limits.maxAssetsPerPage) throw new Error(`page exceeds ${limits.maxAssetsPerPage} image assets`);
        asset = { id: assetId, sourcePath: assetSourcePath, contentType, bytes: existing?.bytes ?? bytes };
        if (budget && !existing) { budget.remainingBytes -= bytes.length; budget.assetsByDigest.set(digest, asset); }
        if (newForPage) assets.push(asset);
        assetReferences.set(assetSourcePath, assetId);
      }
      const assetId = asset?.id ?? assetReferences.get(assetSourcePath)!;
      replacements.push({ start: range[0], end: range[1], value: `![${alt}](molio-asset:${assetId})` });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'image could not be read';
      if (/exceeds \d+ bytes|page exceeds \d+ image assets/i.test(reason)) throw error;
      warnings.push(`${sourcePath}: ${reason}`);
      replacements.push({ start: range[0], end: range[1], value: '[[molio-image-unavailable]]' });
    }
  }
  for (const replacement of replacements.reverse()) {
    projectMarkdown = projectMarkdown.slice(0, replacement.start) + replacement.value + projectMarkdown.slice(replacement.end);
  }
  // Raw Markdown remains admin-only; projection input contains opaque asset IDs instead of local paths.
  return { id, sourcePath, sourceMarkdown, projectMarkdown, title: parsedOriginal.title, assets, warnings };
}

function parseTitleAndBody(sourcePath: string, sourceMarkdown: string): { title: string; body: string } {
  let body = sourceMarkdown;
  let frontmatter = '';
  const fm = sourceMarkdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (fm) {
    frontmatter = fm[1] ?? '';
    body = sourceMarkdown.slice(fm[0].length);
  }
  const titleLine = frontmatter.match(/^title:\s*(.*?)\s*$/m)?.[1];
  const safeTitle = titleLine?.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, '$1$2');
  const heading = body.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  const fileTitle = basename(sourcePath).replace(/\.md$/i, '');
  return { title: safeTitle || heading || fileTitle, body };
}

function normalizeName(value: string): string {
  return value.replace(/[\s_-]+/g, '').toLowerCase();
}

function resolvePublicTarget(rawName: string, sourcePath: string, nameIndex: Map<string, string[]>): string | null {
  const clean = rawName.replace(/\.md$/i, '').trim().toLowerCase();
  if (!clean || /\.(?:png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?)$/i.test(rawName)) return null;
  let matches = nameIndex.get(clean);
  if ((!matches || !matches.length) && clean.includes('/')) matches = nameIndex.get(clean.split('/').pop() ?? clean);
  if (!matches?.length) {
    const fuzzy = normalizeName(clean);
    for (const [key, paths] of nameIndex) {
      if (normalizeName(key) === fuzzy) { matches = paths; break; }
    }
  }
  if (!matches?.length) return null;
  if (matches.length === 1) return matches[0] ?? null;
  const sourceDir = dirname(sourcePath).replaceAll('\\', '/');
  const sameDirectory = matches.filter((candidate) => dirname(candidate).replaceAll('\\', '/') === sourceDir);
  return sameDirectory.length === 1 ? sameDirectory[0] ?? null : null;
}

export function buildPublicationDraft(
  vaultId: string,
  sources: PublicationSourcePage[],
  limits: PublicationLimits = DEFAULT_PUBLICATION_LIMITS,
): PublicationDraft {
  if (sources.length > limits.maxPages) throw new Error(`Publication exceeds ${limits.maxPages} pages`);
  const nameIndex = new Map<string, string[]>();
  const parsed = new Map<string, { title: string; body: string }>();
  let totalBytes = 0;

  for (const source of sources) {
    if (!source.sourcePath.startsWith('wiki/') || !source.sourcePath.toLowerCase().endsWith('.md')) {
      throw new Error('Publication pages must be Markdown files under wiki/');
    }
    const markdownBytes = Buffer.byteLength(source.sourceMarkdown, 'utf8');
    if (markdownBytes > limits.maxMarkdownBytes) throw new Error(`Page exceeds ${limits.maxMarkdownBytes} bytes: ${source.sourcePath}`);
    totalBytes += markdownBytes;
    const info = parseTitleAndBody(source.sourcePath, source.projectMarkdown ?? source.sourceMarkdown);
    parsed.set(source.sourcePath, { ...info, title: source.title ?? info.title });
    const key = basename(source.sourcePath).replace(/\.md$/i, '').toLowerCase();
    const paths = nameIndex.get(key) ?? [];
    paths.push(source.sourcePath);
    nameIndex.set(key, paths);
    if ((source.assets?.length ?? 0) > limits.maxAssetsPerPage) throw new Error(`Page exceeds ${limits.maxAssetsPerPage} image assets: ${source.sourcePath}`);
    for (const asset of source.assets ?? []) {
      if (asset.bytes.length > limits.maxAssetBytes) throw new Error(`Image exceeds ${limits.maxAssetBytes} bytes: ${asset.sourcePath}`);
    }
  }
  const uniqueAssets = new Map<string, PublicationDraftAsset>();
  for (const source of sources) for (const asset of source.assets ?? []) uniqueAssets.set(asset.id, asset);
  for (const asset of uniqueAssets.values()) totalBytes += asset.bytes.length;
  if (totalBytes > limits.maxRevisionBytes) throw new Error(`Publication exceeds ${limits.maxRevisionBytes} bytes`);

  const pathToId = new Map(sources.map((page) => [page.sourcePath, page.id]));
  const edges = new Map<string, { source: string; target: string }>();
  const pages: PublicationDraftPage[] = sources.map((source) => {
    const info = parsed.get(source.sourcePath)!;
    const intervals = codeIntervals(info.body);
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    const linkPattern = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(info.body)) !== null) {
      const range: [number, number] = [match.index, match.index + match[0].length];
      if (intervalOverlaps(range, intervals)) continue;
      const rawTarget = (match[1] ?? '').trim();
      if (rawTarget === 'molio-image-unavailable') continue;
      const targetName = rawTarget.split('#', 1)[0] ?? '';
      const targetPath = resolvePublicTarget(targetName, source.sourcePath, nameIndex);
      const targetId = targetPath ? pathToId.get(targetPath) : undefined;
      if (!targetId || targetId === source.id) {
        replacements.push({ start: range[0], end: range[1], value: '[Unavailable page](molio-unavailable:)' });
        continue;
      }
      const display = (match[2] ?? rawTarget).replace(/[\[\]]/g, '');
      replacements.push({ start: range[0], end: range[1], value: `[${display}](molio-page:${targetId})` });
      const edgeKey = `${source.id}\u0000${targetId}`;
      edges.set(edgeKey, { source: source.id, target: targetId });
    }
    let markdown = info.body;
    for (const replacement of replacements.reverse()) {
      markdown = markdown.slice(0, replacement.start) + replacement.value + markdown.slice(replacement.end);
    }
    return {
      id: source.id,
      sourcePath: source.sourcePath,
      title: info.title,
      sourceMarkdown: source.sourceMarkdown,
      projectMarkdown: source.projectMarkdown ?? source.sourceMarkdown,
      markdown,
      assets: source.assets ?? [],
      warnings: source.warnings ?? [],
    };
  });
  if (edges.size > limits.maxGraphEdges) throw new Error(`Publication exceeds ${limits.maxGraphEdges} graph edges`);
  const graph: PublicGraph = {
    revision: 0,
    nodes: pages.map((page) => ({ id: page.id, title: page.title })),
    edges: [...edges.values()],
  };
  return { vaultId, pages, graph, totalBytes, warnings: pages.flatMap((page) => page.warnings) };
}
