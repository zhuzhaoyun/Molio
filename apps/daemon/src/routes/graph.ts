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
import type { GraphNode, GraphEdge, GraphData, DeadLinkInfo, GraphScope } from '@molio/contracts';

/**
 * 从知识图谱中剔除的文件名：index/log 这类文件只是导航/索引页，不代表知识点，
 * 无论作为节点还是连线目标都没有意义，一律从图谱中剔除（大小写不敏感）。
 */
const GRAPH_EXCLUDED_BASENAMES = new Set(['index', 'log']);

/** 判断某个 .md 文件名（大小写不敏感）是否为图谱剔除的 index/log 类文件。 */
export function isGraphExcludedFile(fileName: string): boolean {
  return GRAPH_EXCLUDED_BASENAMES.has(fileName.replace(/\.md$/i, '').toLowerCase());
}

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
  const deadLinks = new Set<string>(); // Track dead links to avoid repeating warnings (lowercase name)
  // 死链目标节点（Obsidian 行为：未解析的 [[名字]] 也作为节点参与图）：
  // lowercase name → 首次出现的展示名 / 被引用次数
  const deadLabels = new Map<string, string>();
  const deadLinkCounts = new Map<string, number>();

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

      // 指向被剔除文件（index/log）的链接直接忽略，也不记为死链
      const linkBase = (rawName.replace(/\.md$/i, '').split('/').pop() ?? '').toLowerCase();
      if (GRAPH_EXCLUDED_BASENAMES.has(linkBase)) continue;

      // Try to resolve the link target
      const targetKey = resolveLink(rawName, f.path, nameIndex, pathToKey);
      if (!targetKey) {
        // 死链：目标名作为节点并入图，与引用页建立连线（Obsidian 同款）。
        // key 用 lowercase 规范化去重（[[Foo]] 与 [[foo]] 指向同一节点）
        const lowerName = rawName.toLowerCase();
        if (!deadLinks.has(lowerName)) {
          deadLinks.add(lowerName);
          deadLabels.set(lowerName, rawName);
          deadLinkCounts.set(lowerName, 0);
          deadLinksList.push({ sourceFile: f.path, targetName: rawName });
        }
        const deadKey = `__dead__${lowerName}`;
        const edgeKey = sourceKey < deadKey
          ? `${sourceKey}→${deadKey}`
          : `${deadKey}→${sourceKey}`;
        if (!edges.has(edgeKey)) {
          edges.add(edgeKey);
          deadLinkCounts.set(lowerName, (deadLinkCounts.get(lowerName) ?? 0) + 1);
          linkCounts.set(sourceKey, (linkCounts.get(sourceKey) ?? 0) + 1);
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

  // 死链节点：path 为空，deadLink 标记供前端区分样式与「点击新建空白页」
  for (const [lowerName, count] of deadLinkCounts) {
    nodes.push({
      key: `__dead__${lowerName}`,
      label: deadLabels.get(lowerName) ?? lowerName,
      path: '',
      linkCount: count,
      nodeType: undefined,
      deadLink: true,
    });
  }

  // Build edge list
  const edgeList: GraphEdge[] = Array.from(edges).map((ek) => {
    const parts = ek.split('→');
    return { source: parts[0] ?? '', target: parts[1] ?? '' };
  });

  return { nodes, edges: edgeList, deadLinks: deadLinksList };
}

/**
 * Build a scoped sub-graph from the full vault graph（设计 docs/2026-09-04-local-graph-scope-design.md §3）.
 *
 * - file scope：圆心（path 精确匹配）+ 1 跳闭邻域 + 诱导边；圆心不存在/被剔除/孤立（linkCount===0）→ 空图
 * - dir scope：目录前缀下全部 .md 节点 + 它们之间的边；目录内节点引用的目录外死链目标并入；跨目录真实文件边界不含
 * 返回必含 focusNodes：file=圆心单点；dir=子图全部节点；空图=[]（全量图接口不回填该字段）。
 */
// 返回类型收窄：局部图必含 focusNodes（GraphData 里是可选字段，全量图接口才不回填）
export function buildLocalGraph(vaultPath: string, scope: GraphScope): GraphData & { focusNodes: string[] } {
  const full = buildGraph(vaultPath);
  const inSet = new Set<string>();
  let focus: string[] = [];

  if (scope.type === 'file') {
    const center = full.nodes.find((n) => !n.deadLink && n.path === scope.path);
    if (!center || center.linkCount === 0) {
      return { nodes: [], edges: [], deadLinks: [], focusNodes: [] };
    }
    inSet.add(center.key);
    for (const e of full.edges) {
      if (e.source === center.key) inSet.add(e.target);
      else if (e.target === center.key) inSet.add(e.source);
    }
    focus = [center.key];
  } else {
    const prefix = `${scope.path.replace(/\/+$/, '')}/`;
    for (const n of full.nodes) {
      if (!n.deadLink && n.path.startsWith(prefix)) inSet.add(n.key);
    }
    if (inSet.size === 0) {
      return { nodes: [], edges: [], deadLinks: [], focusNodes: [] };
    }
    // 目录内节点链到目录外死链目标 → 死链节点并入（点它可新建页面）；
    // 真实文件的跨目录边界不含（后续增强）。死链节点无出边，不会级联扩散。
    for (const e of full.edges) {
      const sIn = inSet.has(e.source);
      const tIn = inSet.has(e.target);
      if (sIn === tIn) continue;
      const otherKey = sIn ? e.target : e.source;
      if (full.nodes.some((n) => n.key === otherKey && n.deadLink)) inSet.add(otherKey);
    }
    focus = Array.from(inSet);
  }

  const nodes = full.nodes.filter((n) => inSet.has(n.key));
  const keys = new Set(nodes.map((n) => n.key));
  const edges = full.edges.filter((e) => keys.has(e.source) && keys.has(e.target));
  // deadLinks 元数据按「死链节点在子图内」过滤（不按 sourceFile——首见 source 可能不在子图）
  const deadLinks = full.deadLinks.filter((d) => keys.has(`__dead__${d.targetName.toLowerCase()}`));
  return { nodes, edges, deadLinks, focusNodes: focus };
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
    if (node.type === 'file' && node.name.endsWith('.md') && !isGraphExcludedFile(node.name)) {
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
  // Strip any .md extension from the link text
  let cleanName = rawName.replace(/\.md$/i, '').trim().toLowerCase();

  // Skip non-.md files (images, etc.)
  if (rawName.match(/\.(png|jpg|jpeg|gif|svg|webp|pdf|docx?|xlsx?)$/i)) {
    return null;
  }

  // Case 1: Look up by exact name in the index
  let candidates = nameIndex.get(cleanName);
  if (!candidates || candidates.length === 0) {
    // Case 2: The link text may include a directory path like [[开发/概念/知识库五范式]].
    // Extract just the basename (last segment) for matching.
    if (cleanName.includes('/')) {
      const baseOnly = cleanName.split('/').pop() ?? cleanName;
      if (baseOnly !== cleanName) {
        candidates = nameIndex.get(baseOnly);
      }
    }
  }
  if (!candidates || candidates.length === 0) {
    // Case 3: Fuzzy match — strip spaces/dashes/underscores for comparison.
    // AI-generated wikilinks like [[AI Safety]] may not match filename
    // ai-safety.md with exact string comparison.
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