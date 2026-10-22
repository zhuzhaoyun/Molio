/**
 * Graph API routes — knowledge graph data for visualisation.
 *
 * 图的实际构建（扫描整库 + 解析 [[wikilinks]]）在 `core/graph-build.ts`，
 * 并且跑在 worker 线程里（core/vault-worker.ts）：整库扫描是秒级的同步操作，
 * 留在请求线程上会连带卡住文件树与聊天 SSE。
 * 这里只负责 HTTP：取 vault、过缓存、裁局部图、错误映射。
 */

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { getVault } from '../core/db.js';
import { GraphCache } from '../core/graph-cache.js';
import { filterLocalGraph } from '../core/graph-build.js';
import { buildGraphInWorker } from '../core/vault-worker.js';
import type { GraphData, GraphScope } from '@molio/contracts';

// 兼容既有导入点（测试与一次性调用都从这里拿）——实现已经搬去 core/graph-build.ts。
// 注意：这里导出的是**同步**的进程内实现；HTTP 路由走的是 worker 版本。
export { buildGraph, buildLocalGraph, filterLocalGraph, isGraphExcludedFile } from '../core/graph-build.js';

/**
 * 缓存只在「失效信号活着」的 vault 上生效：库内容变了必须有东西来告诉缓存。
 * VaultWatcher 的 tree-changed 就是那个信号，但它在**监听就绪前、以及监听失败
 * 后是不存在的**（watch() 是 fire-and-forget，失败只 warn）。没有信号还缓存，
 * 就等于把「没有信号」当成「内容没变」——图谱会停在旧数据上直到 TTL 到期。
 */
async function buildGraphCached(
  cache: GraphCache,
  vault: { id: string; path: string },
  isCacheable: (vaultId: string) => boolean,
): Promise<GraphData> {
  if (!isCacheable(vault.id)) return buildGraphInWorker(vault.path);
  return cache.getOrBuild(vault.id, () => buildGraphInWorker(vault.path));
}

/**
 * @param cache 图谱缓存。默认自建一个（每个 app 实例一份）——server.ts 会把
 *   VaultWatcher 的 tree-changed 接到同一个实例上做失效；测试可注入受控实例。
 * @param isCacheable 该 vault 现在能不能吃缓存（默认总是可以）。server.ts 传
 *   VaultWatcher.isReady；测试可注入受控判定。
 */
export function graphRoutes(
  db: Database.Database,
  cache: GraphCache = new GraphCache(),
  isCacheable: (vaultId: string) => boolean = () => true,
): Hono {
  const app = new Hono();

  // GET /api/graph/:vaultId — build graph from vault markdown files
  app.get('/:vaultId', async (c) => {
    const vault = getVault(db, c.req.param('vaultId'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const graphData = await buildGraphCached(cache, vault, isCacheable);
      return c.json(graphData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build graph';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // GET /api/graph/:vaultId/local — scoped sub-graph（file=1跳邻域 / dir=文件夹子图）
  app.get('/:vaultId/local', async (c) => {
    const vault = getVault(db, c.req.param('vaultId'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const scopeType = c.req.query('scope');
    if (scopeType !== 'file' && scopeType !== 'dir') {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: "query 'scope' must be 'file' or 'dir'" } },
        400,
      );
    }
    const scopePath = (c.req.query('path') ?? '').trim().replace(/\/+$/, '');
    if (!scopePath) {
      return c.json({ error: { code: 'BAD_REQUEST', message: "query 'path' is required" } }, 400);
    }
    const depthRaw = c.req.query('depth');
    let depth = 1;
    if (depthRaw != null && depthRaw !== '') {
      depth = Number(depthRaw);
      if (!Number.isInteger(depth) || depth < 1) {
        return c.json(
          { error: { code: 'BAD_REQUEST', message: "query 'depth' must be a positive integer" } },
          400,
        );
      }
      if (depth > 1) {
        return c.json(
          { error: { code: 'BAD_REQUEST', message: 'depth > 1 is not supported yet' } },
          400,
        );
      }
    }

    try {
      const scope: GraphScope =
        scopeType === 'file' ? { type: 'file', path: scopePath, depth } : { type: 'dir', path: scopePath };
      // 局部图 = 同一张全量图做一次过滤：缓存全量图，切 scope 就不用重扫整库
      const full = await buildGraphCached(cache, vault, isCacheable);
      return c.json(filterLocalGraph(full, scope));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build local graph';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  return app;
}
