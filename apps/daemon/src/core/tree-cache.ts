/**
 * Per-vault 文件树缓存。
 *
 * 为什么需要：`GET /vaults/:id/tree` 每次都 `scanTree` **同步**遍历整棵目录树。
 * 实测用户从移动硬盘挂载的库（盘上 7 万文件）单次扫描要几秒，而打开知识库 /
 * 切库 / 窗口聚焦都会拉树——同一棵树被反复重扫，且扫描期间 daemon 干不了别的。
 * 与图谱缓存（core/graph-cache.ts，PR #337）同一个病，同一套药。
 *
 * 缓存的是**标注后**的树（scanTree + annotateTreeStatus 的产物）：annotate 会
 * 原地改节点（写入 ingestStatus），必须和扫描一起重算，不能每次请求对缓存的
 * 树重复标注。
 *
 * **getOrBuild 是 async + single-flight**：冷缓存上并发的多个请求只触发一次
 * 构建，其余等待同一个 Promise（图谱缓存是同步的所以天然没有这个问题；树这
 * 边扫描要几秒，用户切库 + 聚焦很容易在窗口内打出两三个请求）。build 抛错时
 * 清掉 in-flight、不写缓存、原样上抛——失败不该被记住。
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
 *
 * **TTL 再兜一层**：信号中途哑掉（chokidar 掉事件、盘掉线）也不会无限期陈旧。
 * 默认 2 分钟，测试可用构造参数改。
 */
import type { TreeNode } from '@molio/contracts';

/** 同时缓存的 vault 数上限（多库切换时按 LRU 淘汰）。 */
const DEFAULT_MAX_ENTRIES = 4;
const DEFAULT_TTL_MS = 2 * 60 * 1000;

export class TreeCache {
  private entries = new Map<string, { tree: TreeNode[]; builtAt: number }>();
  /** 构建中的 vault → 共享 Promise + 构建开始时的失效代次（single-flight）。 */
  private inflight = new Map<string, { promise: Promise<TreeNode[]>; generation: number }>();
  /**
   * 每个 vault 的失效代次（单调递增）。用计数而不是时间戳：同一毫秒内的
   * invalidate 与构建开始无法按时间排序，会让「写前快照」被误当作写后。
   */
  private generation = new Map<string, number>();

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
  async getOrBuild(vaultId: string, build: () => Promise<TreeNode[]>): Promise<TreeNode[]> {
    const hit = this.entries.get(vaultId);
    if (hit && this.now() - hit.builtAt < this.ttlMs) {
      // LRU：Map 保持插入序，命中后重新插到末尾表示「最近用过」
      this.entries.delete(vaultId);
      this.entries.set(vaultId, hit);
      return hit.tree;
    }

    // 只有「同代次」的在飞构建才能 join。失效前开始的构建返回的是写前快照：
    // API 写成功后紧跟的刷新若 join 它，刚建的文件就看不见（回归）。
    // 代价：跨失效的窗口里同一 vault 可能短暂并行两次扫描（旧构建的等待者拿到
    // 点内快照后即结束）。scanTree 是同步的，这个窗口通常只有毫秒级。
    const generation = this.generation.get(vaultId) ?? 0;
    const pending = this.inflight.get(vaultId);
    if (pending && pending.generation === generation) {
      return pending.promise;
    }

    // 占位 promise，先建 entry 以便 then/catch 里用身份判断「在飞的还是不是我」：
    // 失效后可能另起一次构建，旧的落定绝不能删掉新构建的记录。
    const entry: { promise: Promise<TreeNode[]>; generation: number } = {
      generation,
      promise: Promise.resolve([]),
    };
    entry.promise = build()
      .then((tree) => {
        if (this.inflight.get(vaultId) === entry) this.inflight.delete(vaultId);
        // 构建期间发生过失效（tree-changed / API 写）→ 这份树是开始扫描时的
        // 快照，失效要的正是它别被记住。照常返回给本次调用（点内快照仍有效），
        // 但不入缓存——下一次请求重新构建。
        if ((this.generation.get(vaultId) ?? 0) !== generation) return tree;
        this.entries.delete(vaultId); // 过期条目先摘掉，保证 set 后它在末尾
        this.entries.set(vaultId, { tree, builtAt: this.now() });
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
        }
        return tree;
      })
      .catch((err) => {
        if (this.inflight.get(vaultId) === entry) this.inflight.delete(vaultId);
        throw err;
      });
    this.inflight.set(vaultId, entry);
    return entry.promise;
  }

  /** 库内容变了（tree-changed / API 写成功）时调用。重复调用无害。 */
  invalidate(vaultId: string): void {
    this.generation.set(vaultId, (this.generation.get(vaultId) ?? 0) + 1);
    this.entries.delete(vaultId);
  }

  /** 测试/关停用。 */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.generation.clear();
  }
}
