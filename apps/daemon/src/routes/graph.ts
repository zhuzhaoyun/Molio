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

export interface GraphNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
function buildGraph(vaultPath: string): GraphData {
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

  for (const f of mdFiles) {
    const relPath = f.path;
    const key = relPath; // Use relative path as unique key
    pathToKey.set(relPath, key);

    // index by basename (no .md extension)
    const basename = f.name.replace(/\.md$/i, '').toLowerCase();
    if (!nameIndex.has(basename)) {
      nameIndex.set(basename, []);
    }
    nameIndex.get(basename)!.push(relPath);

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
      if (!targetKey || targetKey === sourceKey) continue;

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
  }));

  // Build edge list
  const edgeList: GraphEdge[] = Array.from(edges).map((ek) => {
    const parts = ek.split('→');
    return { source: parts[0] ?? '', target: parts[1] ?? '' };
  });

  return { nodes, edges: edgeList };
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
function resolveLink(
  rawName: string,
  sourcePath: string,
  nameIndex: Map<string, string[]>,
  pathToKey: Map<string, string>,
): string | null {
  // Strip any .md extension from the link text
  const cleanName = rawName.replace(/\.md$/i, '').trim().toLowerCase();

  // Case 1: Look up by clean name in the index
  const candidates = nameIndex.get(cleanName);
  if (!candidates || candidates.length === 0) return null;

  if (candidates.length === 1) {
    const first = candidates[0];
    return first ? (pathToKey.get(first) ?? null) : null;
  }

  // Multiple candidates — prefer same directory as source
  const sourceDir = sourcePath.includes('/')
    ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
    : '';

  for (const c of candidates) {
    const candDir = c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '';
    if (candDir === sourceDir) {
      return pathToKey.get(c) ?? null;
    }
  }

  // Fallback: return first candidate
  const fallback = candidates[0];
  return fallback ? (pathToKey.get(fallback) ?? null) : null;
}