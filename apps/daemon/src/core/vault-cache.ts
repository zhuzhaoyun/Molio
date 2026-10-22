/**
 * Per-vault 异步结果缓存（按 vault 建一次、失效即弃）。
 *
 * 图谱（core/graph-cache.ts）与文件树（core/tree-cache.ts）共用这一份实现：
 * 两者的语义完全一致，只是缓存的值不同。共同不变量：
 *
 * - **按 vault 缓存 + LRU**：多库切换时最多留 `maxEntries` 份；
 * - **TTL 兜底**：即便失效信号中途哑掉（chokidar 掉事件、盘掉线），缓存也不会
 *   无限期陈旧；
 * - **single-flight**：冷缓存上的并发请求只触发一次构建，其余等待同一个
 *   Promise。构建耗时几秒，切库 + 聚焦很容易在窗口内打出两三个请求；
 * - **构建期间的失效不被吞**：构建是 async 的，invalidate 可能落在「已经开扫、
 *   还没写完缓存」的窗口里。那种情况下算出来的快照不能入库（照常返回给本次
 *   调用），否则一次失效会被静默吃掉，旧数据要挂到 TTL 到期；
 * - **失败不入缓存**：build 抛错时清掉 in-flight、不写缓存、原样上抛。
 *
 * **失效信号**：VaultWatcher 的 `tree-changed`（内容变了）+ `watch-state-changed`
 * （监听就绪/失活）。调用方还必须按 `VaultWatcher.isReady` 门控**要不要用缓存**：
 * watch() 是 fire-and-forget，监听就绪前、以及监听失败后都没有事件，此时缓存
 * 等于把「没有信号」当成「内容没变」。见 graph-cache.ts / tree-cache.ts。
 */

/** 同时缓存的 vault 数上限（多库切换时按 LRU 淘汰）。 */
const DEFAULT_MAX_ENTRIES = 4;
const DEFAULT_TTL_MS = 2 * 60 * 1000;

export class VaultCache<T> {
  private entries = new Map<string, { value: T; builtAt: number }>();
  /** 构建中的 vault → 共享 Promise（single-flight）。 */
  private inflight = new Map<string, Promise<T>>();
  /** 最近一次失效的时间戳——用于识别「构建期间发生的失效」。 */
  private invalidatedAt = new Map<string, number>();

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    /** 时钟注入（TTL 测试用）。 */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 命中且未过期则复用；否则构建（并发的多个调用共享同一次构建）。
   *
   * `build` 抛错时不写缓存、原样上抛（路由层把它转成 500）——失败不该被记住，
   * in-flight 记录也会清掉，下次调用重新构建。
   */
  async getOrBuild(vaultId: string, build: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(vaultId);
    if (hit && this.now() - hit.builtAt < this.ttlMs) {
      // LRU：Map 保持插入序，命中后重新插到末尾表示「最近用过」
      this.entries.delete(vaultId);
      this.entries.set(vaultId, hit);
      return hit.value;
    }

    const pending = this.inflight.get(vaultId);
    if (pending) return pending;

    const startedAt = this.now();
    const building = build()
      .then((value) => {
        this.inflight.delete(vaultId);
        // 构建期间发生过失效（tree-changed / API 写）→ 这份结果是开始扫描时的
        // 快照，失效要的正是它别被记住。照常返回给本次调用（点内快照仍有效），
        // 但不入库——下一次请求重新构建。
        if ((this.invalidatedAt.get(vaultId) ?? 0) > startedAt) {
          this.invalidatedAt.delete(vaultId);
          return value;
        }
        this.invalidatedAt.delete(vaultId);
        this.entries.delete(vaultId); // 过期条目先摘掉，保证 set 后它在末尾
        this.entries.set(vaultId, { value, builtAt: this.now() });
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
        }
        return value;
      })
      .catch((err) => {
        this.inflight.delete(vaultId);
        throw err;
      });
    this.inflight.set(vaultId, building);
    return building;
  }

  /** 库内容变了（tree-changed / API 写成功）或监听就绪态翻转时调用。重复调用无害。 */
  invalidate(vaultId: string): void {
    this.invalidatedAt.set(vaultId, this.now());
    this.entries.delete(vaultId);
  }

  /** 测试/关停用。 */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
