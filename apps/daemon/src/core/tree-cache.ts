/**
 * Per-vault 文件树缓存。
 *
 * 为什么需要：`GET /vaults/:id/tree` 每次都 `scanTree` **同步**遍历整棵目录树。
 * 实测用户从移动硬盘挂载的库（盘上 7 万文件）单次扫描要几秒，而打开知识库 /
 * 切库 / 窗口聚焦都会拉树——同一棵树被反复重扫，且扫描期间 daemon 干不了别的。
 *
 * 缓存的是**标注后**的树（scanTree + annotateTreeStatus 的产物）：annotate 会
 * 原地改节点（写入 ingestStatus），必须和扫描一起重算，不能每次请求对缓存的
 * 树重复标注。
 *
 * 缓存语义（single-flight / 构建中途失效 / TTL / LRU / 失败不入缓存）见
 * core/vault-cache.ts——与图谱缓存共用同一份实现。
 *
 * **失效**（两路都要，缺一不可）：
 * - VaultWatcher 的 `tree-changed`：覆盖外部编辑器 / agent 直写磁盘（经
 *   chokidar，Windows 上有 ~1s 轮询 + 300ms 去抖延迟）；
 * - **API 写路径就地失效**：新建/删除/重命名/导入成功后立刻 invalidate——
 *   不能等 chokidar，否则用户刚建的文件刷新树看不到（无缓存时代是即时可见的，
 *   这属于回归）。
 *
 * **但缓存只有在信号活着时才允许生效**：watch() 是 fire-and-forget 的，初次
 * 扫描完成前、以及监听失败后都不会有事件（见 graph-cache.ts 同款论证）。路由
 * 按 `VaultWatcher.isReady` 判定——没就绪就每次重建（回到没有缓存时的行为）。
 */
import type { TreeNode } from '@molio/contracts';
import { VaultCache } from './vault-cache.js';

export class TreeCache extends VaultCache<TreeNode[]> {}
