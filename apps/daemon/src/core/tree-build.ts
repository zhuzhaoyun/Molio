/**
 * 文件树构建 = 扫描 + wiki 状态标注。
 *
 * 从 `routes/knowledge.ts` 拆出来是为了能**在 worker 线程里跑**：路由模块 import 了
 * 数据库层，worker 只该拿 vault 路径干活（同 core/graph-build.ts 的理由）。
 */

import type { TreeNode } from '@molio/contracts';
import { scanTree } from './knowledge.js';
import { annotateTreeStatus } from './wiki-status.js';
import type { ExternalRootRef } from './external-roots.js';

/**
 * 扫描 + wiki 状态标注（annotateTreeStatus **原地改树**，两者必须一起重算，
 * 不能对缓存下来的树重复标注）。
 *
 * `externalRoots`：挂载的外部素材根（#255）——树必须包含 external/<label>/...
 * 的挂载内容。原 routes/knowledge.ts 内联实现直接吃这个参数，重构进 core 时
 * 随迁（rebase 到含 #255 的 main，2026-11-14）。
 */
export async function buildAnnotatedTree(
  vaultPath: string,
  externalRoots: ExternalRootRef[] = [],
): Promise<TreeNode[]> {
  const tree = scanTree(vaultPath, '', { externalRoots });
  // Annotate with ingest status (only if the vault has a wiki).
  await annotateTreeStatus(vaultPath, tree);
  return tree;
}
