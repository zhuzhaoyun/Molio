import type Database from 'better-sqlite3';
import { VaultWatcher, VAULT_TREE_CHANGED_EVENT, VAULT_WATCH_STATE_CHANGED_EVENT } from './core/vault-watcher.js';
import { VaultIndexSweeper } from './core/vault-search.js';
import { GraphCache } from './core/graph-cache.js';
import { TreeCache } from './core/tree-cache.js';

export function createKnowledgeServices(db: Database.Database) {
  const vaultWatcher = new VaultWatcher(db);
  // 检索 P0 层1：vault 文件索引新鲜度巡检。tree-changed（agent/外部落盘）防抖增量
  // 重建；启动时对已挂载 vault 各排一次，补齐停机期间的外部改动。
  const vaultIndexSweeper = new VaultIndexSweeper(db);
  vaultWatcher.on(VAULT_TREE_CHANGED_EVENT, (vaultId: string) => vaultIndexSweeper.scheduleVault(vaultId));
  // 监听重臂（watch() 先关旧实例再开新的，落盘事件可能在盲窗里丢）也要巡检一次：
  // 就绪态翻转说明「信号曾经断过」，断窗里的改动没有 tree-changed 可依赖。
  vaultWatcher.on(VAULT_WATCH_STATE_CHANGED_EVENT, (vaultId: string) => vaultIndexSweeper.scheduleVault(vaultId));
  vaultIndexSweeper.scheduleAll();
  // 图谱全量结果按 vault 缓存：buildGraph 是同步整库扫描（实测移动盘大库 5.2s，
  // 期间阻塞整个 daemon），而打开图谱 / 每次切 scope 都在调它。
  // 失效同样挂在 tree-changed 上——与上面的 FTS 巡检共用「库内容变了」这一个信号。
  const graphCache = new GraphCache();
  vaultWatcher.on(VAULT_TREE_CHANGED_EVENT, (vaultId: string) => graphCache.invalidate(vaultId));
  // 监听就绪/失活也要清：watch() 是 fire-and-forget，扫描完成前（以及监听失败后）
  // 落盘的变化根本没有事件——那个空窗里算出来的图不能留在缓存里当真相。
  vaultWatcher.on(VAULT_WATCH_STATE_CHANGED_EVENT, (vaultId: string) => graphCache.invalidate(vaultId));
  // 文件树同病同药：GET /vaults/:id/tree 每次同步重扫整棵目录树（移动盘大库几秒），
  // 打开知识库 / 切库 / 聚焦都在调它。失效与图谱缓存完全同构——tree-changed +
  // 就绪态翻转；API 写路径的就地失效在 routes/knowledge.ts 的各写 handler 里。
  const treeCache = new TreeCache();
  vaultWatcher.on(VAULT_TREE_CHANGED_EVENT, (vaultId: string) => treeCache.invalidate(vaultId));
  vaultWatcher.on(VAULT_WATCH_STATE_CHANGED_EVENT, (vaultId: string) => treeCache.invalidate(vaultId));
  return { vaultWatcher, vaultIndexSweeper, graphCache, treeCache };
}
