/**
 * Graph API routes — knowledge graph data for visualisation.
 *
 * Builds a node-edge graph from vault markdown files by parsing [[wikilinks]].
 */

import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getVault } from '../core/db.js';
import { scanTree, resolveFilePath } from '../core/knowledge.js';
import type { GraphNode, GraphEdge, GraphData, DeadLinkInfo } from '@molio/contracts';

/**
 * Infer node type from frontmatter or directory path.
 */
function inferNodeType(filePath: string, content: string): string | undefined {
  // 1. Parse frontmatter for `type:` field
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1] ?? '';
    const typeMatch = fm.match(/^type:\s*(.+)$/m);
    if (typeMatch) {
      const t = typeMatch[1]!.trim().replace(/^["']|["']$/g, '');
      if (t) return t;
    }
  }

  // 2. Infer from wiki directory structure
  if (filePath.startsWith('wiki/sources/')) return 'source';
  if (filePath.startsWith('wiki/entities/')) return 'entity';
  if (filePath.startsWith('wiki/concepts/')) return 'concept';
  if (filePath.startsWith('wiki/comparisons/')) return 'comparison';
  if (filePath.startsWith('wiki/questions/')) return 'question';
  if (filePath.startsWith('wiki/')) return 'wiki';

  // 3. Default
  return 'document';
}

export function graphRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // GET /api/graph/:vaultId — build graph from vault markdown files
  app.get('/:vaultId', (c) => {
    const vault = getVault(db, c.req.param('vaultId'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const graphData = buildGraph(vault.path);
      return c.json(graphData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build graph';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  return app;
}

/**
 * Scan all .md files in a vault, parse [[wikilinks]], and build a graph.
 */
export function buildGraph(vaultPath: string): GraphData {
  const tree = scanTree(vaultPath);

  // Collect all .md files (nodes)
  const mdFiles: { name: string; path: string }[] = [];
  collectMdFiles(tree, '', mdFiles);

  // Build map: file basename (no ext) → list of relative paths (for link resolution)
  const nameIndex = new Map<string, string[]>();
  // Build map: relative path → node key (for edge dedup)
  const pathToKey = new Map<string, string>();
  // Counter for link counts
  const linkCounts = new Map<string, number>();
  // Map for node types
  const nodeTypes = new Map<string, string | undefined>();
  // Dead links list
  const deadLinksList: DeadLinkInfo[] = [];

  for (const f of mdFiles) {
    const relPath = f.path;
    const key = relPath; // Use relative path as unique key
    pathToKey.set(relPath, key);
    pathToKey.set(relPath.replace(/\\/g, '/').toLowerCase(), key);

    // index by basename (no .md extension)
    const basename = f.name.replace(/\.md$/i, '').toLowerCase();
    if (!nameIndex.has(basename)) {
      nameIndex.set(basename, []);
    }
    nameIndex.get(basename)!.push(relPath);

    // Read file content for node type inference
    const absPath = resolveFilePath(vaultPath, f.path);
    let content = '';
    try {
      content = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
    } catch { /* binary or unreadable */ }

    const nodeType = inferNodeType(f.path, content);
    nodeTypes.set(key, nodeType);
    linkCounts.set(key, 0);
  }

  // Parse wikilinks from each file
  const edges = new Set<string>(); // "source→target" strings for dedup
  const deadLinks = new Set<string>(); // Track dead links to avoid repeating warnings

  for (const f of mdFiles) {
    const absPath = resolveFilePath(vaultPath, f.path);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, 'utf-8');
    const sourceKey = pathToKey.get(f.path)!;

    // Match [[Page Name]] and [[Page Name|display]]
    const linkRegex = /\[\[([^\]|#]+?)(?:\|[^\]]+)?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(content)) !== null) {
      const rawName = (match[1] ?? '').trim();
      if (!rawName) continue;

      // Try to resolve the link target
      const targetKey = resolveLink(rawName, f.path, nameIndex, pathToKey);
      if (!targetKey) {
        // Record dead link
        if (!deadLinks.has(rawName.toLowerCase())) {
          deadLinks.add(rawName.toLowerCase());
          deadLinksList.push({ sourceFile: f.path, targetName: rawName });
        }
        continue;
      }
      if (targetKey === sourceKey) continue;

      const edgeKey = sourceKey < targetKey
        ? `${sourceKey}→${targetKey}`
        : `${targetKey}→${sourceKey}`;

      if (!edges.has(edgeKey)) {
        edges.add(edgeKey);
        linkCounts.set(sourceKey, (linkCounts.get(sourceKey) ?? 0) + 1);
        linkCounts.set(targetKey, (linkCounts.get(targetKey) ?? 0) + 1);
      }
    }
  }

  // Build node list
  const nodes: GraphNode[] = mdFiles.map((f) => ({
    key: pathToKey.get(f.path)!,
    label: f.name.replace(/\.md$/i, ''),
    path: f.path,
    linkCount: linkCounts.get(pathToKey.get(f.path)!) ?? 0,
    nodeType: nodeTypes.get(pathToKey.get(f.path)!),
  }));

  // Build edge list
  const edgeList: GraphEdge[] = Array.from(edges).map((ek) => {
    const parts = ek.split('→');
    return { source: parts[0] ?? '', target: parts[1] ?? '' };
  });

  return { nodes, edges: edgeList, deadLinks: deadLinksList };
}

/**
 * Collect all .md file entries from the tree recursively.
 */
function collectMdFiles(
  nodes: { name: string; path: string; type: string; children?: unknown[] }[],
  prefix: string,
  result: { name: string; path: string }[],
) {
  for (const node of nodes) {
    if (node.type === 'file' && node.name.endsWith('.md')) {
      result.push({ name: node.name, path: node.path });
    } else if (node.type === 'directory' && Array.isArray(node.children)) {
      collectMdFiles(node.children as typeof nodes, node.path, result);
    }
  }
}

/**
 * Resolve a wikilink target name to a node key (relative file path).
 *
 * Resolution strategy:
 * 1. Exact relative path match (already includes directory prefix)
 * 2. Basename match in the nameIndex
 * 3. If multiple matches with same basename, prefer same-directory one
 */
/** Strip spaces/dashes/underscores for fuzzy name matching. */
function normalizeName(name: string): string {
  return name.replace(/[\s_\-]+/g, '').toLowerCase();
}

function resolveLink(
  rawName: string,
  sourcePath: string,
  nameIndex: Map<string, string[]>,
  pathToKey: Map<string, string>,
): string | null {
  // Skip non-.md files
  if (rawName.match(/\.(png|jpg|jpeg|gif|svg|webp|pdf|docx?|xlsx?)$/i)) return null;

  const normalizedTarget = rawName
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|^\.\//g, '')
    .replace(/\.md$/i, '')
    .toLowerCase();

  // 1. Path-qualified exact match (before basename/fuzzy fallback)
  const exactCandidates = [`${normalizedTarget}.md`];
  if (sourcePath.startsWith('wiki/') && !normalizedTarget.startsWith('wiki/')) {
    exactCandidates.push(`wiki/${normalizedTarget}.md`);
  }
  for (const candidate of exactCandidates) {
    const exact = pathToKey.get(candidate);
    if (exact) return exact;
  }

  // 2. Basename fallback (existing logic)
  let cleanName = normalizedTarget;
  let candidates = nameIndex.get(cleanName);
  if (!candidates || candidates.length === 0) {
    if (cleanName.includes('/')) {
      const baseOnly = cleanName.split('/').pop() ?? cleanName;
      if (baseOnly !== cleanName) {
        candidates = nameIndex.get(baseOnly);
      }
    }
  }

  // 3. Fuzzy match
  if (!candidates || candidates.length === 0) {
    const fuzzyKey = normalizeName(cleanName);
    for (const [key, paths] of nameIndex) {
      if (normalizeName(key) === fuzzyKey) {
        candidates = paths;
        break;
      }
    }
  }
  if (!candidates || candidates.length === 0) return null;

  if (candidates.length === 1) {
    const first = candidates[0];
    return first ? (pathToKey.get(first) ?? null) : null;
  }

  // Same-directory preference
  const sourceDir = sourcePath.includes('/')
    ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
    : '';

  for (const c of candidates) {
    const candDir = c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '';
    if (candDir === sourceDir) return pathToKey.get(c) ?? null;
  }

  const fallback = candidates[0];
  return fallback ? (pathToKey.get(fallback) ?? null) : null;
}