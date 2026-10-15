/**
 * Per-vault 知识图谱缓存。
 *
 * 为什么需要：`buildGraph` 每次都要整库走一遍目录树 + 逐文件读内容解析
 * `[[wikilink]]`，全程**同步**跑在请求线程里。实测用户从移动硬盘挂载的库
 * （盘上 70k 文件 / 6.5k md）单次重建 5.2s，而打开图谱、每次切 scope
 * （全量图 ⇄ 局部图 ⇄ 另一个局部图）都在调它——同一份图被反复重算，
 * 且这 5.2s 里 daemon 干不了别的（文件树、聊天 SSE 一起卡）。
 *
 * 命中后局部图只是对同一张全量图做过滤，所以缓存全量图就够了（见
 * routes/graph.ts 的 filterLocalGraph）。
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
 *
 * **TTL 再兜一层**：即便信号中途哑掉（chokidar 掉事件、盘掉线），缓存也不会
 * 无限期陈旧。默认 2 分钟，测试可用构造参数改。
 */
import type { GraphData } from '@molio/contracts';

/** 同时缓存的 vault 数上限（多库切换时按 LRU 淘汰）。 */
const DEFAULT_MAX_ENTRIES = 4;
const DEFAULT_TTL_MS = 2 * 60 * 1000;

export class GraphCache {
  private entries = new Map<string, { graph: GraphData; builtAt: number }>();

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    /** 时钟注入（TTL 测试用）。 */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 命中且未过期则复用，否则调用 `build` 重建。
   *
   * `build` 抛错时不写缓存、原样上抛（路由层把它转成 500）——失败不该被记住。
   */
  getOrBuild(vaultId: string, build: () => GraphData): GraphData {
    const hit = this.entries.get(vaultId);
    if (hit && this.now() - hit.builtAt < this.ttlMs) {
      // LRU：Map 保持插入序，命中后重新插到末尾表示「最近用过」
      this.entries.delete(vaultId);
      this.entries.set(vaultId, hit);
      return hit.graph;
    }

    const graph = build();
    this.entries.delete(vaultId); // 过期条目先摘掉，保证下面 set 后它在末尾
    this.entries.set(vaultId, { graph, builtAt: this.now() });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return graph;
  }

  /** 库内容变了（tree-changed）时调用。重复调用无害。 */
  invalidate(vaultId: string): void {
    this.entries.delete(vaultId);
  }

  /** 测试/关停用。 */
  clear(): void {
    this.entries.clear();
  }
}
