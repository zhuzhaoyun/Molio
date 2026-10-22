/**
 * Per-vault 知识图谱缓存。
 *
 * 为什么需要：`buildGraph` 每次都要整库走一遍目录树 + 逐文件读内容解析
 * `[[wikilink]]`，实测用户从移动硬盘挂载的库（盘上 70k 文件 / 6.5k md）单次
 * 重建 5.2s，而打开图谱、每次切 scope（全量图 ⇄ 局部图 ⇄ 另一个局部图）都在
 * 调它——同一份图被反复重算。
 *
 * 命中后局部图只是对同一张全量图做过滤，所以缓存全量图就够了（见
 * core/graph-build.ts 的 filterLocalGraph）。
 *
 * 缓存语义（single-flight / 构建中途失效 / TTL / LRU / 失败不入缓存）见
 * core/vault-cache.ts——与文件树缓存共用同一份实现。
 *
 * **失效**：VaultWatcher 的 `tree-changed`。外部编辑器 / agent 直写磁盘、
 * 以及经 Molio API 的写入都会经 chokidar 触发它——VaultIndexSweeper
 * （FTS 索引新鲜度，core/vault-search.ts）用的就是同一个信号，本项目已经
 * 把它当作「库内容变了」的权威来源。
 *
 * **但缓存只有在那个信号活着时才允许生效**：watch() 是 fire-and-forget 的，
 * 初次扫描完成前、以及监听失败后都不会有事件。routes/graph.ts 因此按
 * `VaultWatcher.isReady` 判定——没就绪就每次重建（回到没有缓存时的行为），
 * 就绪/失活的翻转也会清掉缓存。
 */
import type { GraphData } from '@molio/contracts';
import { VaultCache } from './vault-cache.js';

export class GraphCache extends VaultCache<GraphData> {}
