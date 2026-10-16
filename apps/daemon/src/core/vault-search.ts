/**
 * Vault 文件全文索引（检索 P0 层 1）——索引器。
 * 查询端见本文件 searchVaultFiles；写路径挂钩在 routes/knowledge.ts；
 * 外部/agent 编辑的新鲜度由 VaultIndexSweeper（tree-changed 防抖）+ 搜索时
 * 惰性校验共同保证。设计：docs/2026-10-10-retrieval-p0.md §4.1。
 *
 * **索引构建一律分片让位**（见 INDEX_YIELD_EVERY_FILES）：daemon 是单线程，
 * 且它同时托管 Web UI 的静态资源——一次整库冷索引（首次启动/新库/大改动后）
 * 若独占事件循环，连自己托管的 chunk 都发不出去：界面表现为「点设置不切页」
 * 「切库不弹新窗口」（2026-10-16 Windows v0.3.61-beta 报障，mac 实测 5000 文件
 * 冷索引黑屏 6.3s）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SearchResult } from '@molio/contracts';
import { getVault, type SqliteDb } from './db.js';
import { TEXT_EXTS } from './knowledge.js';
import { isPrunedDirName, MAX_DIR_ENTRIES, MAX_TOTAL } from './vault-prune.js';

export const MAX_INDEX_FILE_BYTES = 2 * 1024 * 1024;

/** 与 knowledge.ts assertWithinVault 同款边界检查（不 import 它，避免拖入 trash/encoding）。 */
function assertWithinVault(vaultPath: string, resolved: string): void {
  const root = path.resolve(vaultPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
}

function isIndexableExt(relPath: string): boolean {
  return TEXT_EXTS.includes(path.extname(relPath).toLowerCase());
}

/**
 * rowid 配对约定（2026-10-16 Windows 卡死事故后引入）：FTS 行的 rowid 恒等于
 * vault_files_state 对应行的 rowid。fts 表上 vault_id/file_path 是 UNINDEXED 列，
 * 按它们 DELETE 是**全表扫描**——每行都要读出 content（trigram 大文本）比对。
 * 一个几千文件、几亿字节的库单条 DELETE 就秒级 CPU；walk 里每个非文本文件
 * （图片/PDF，isIndexableExt 不过）都会走到 removeVaultFile，几百条秒级扫描连
 * 成片，事件循环被独占几分钟（分片让位救不了单条语句的开销——50 个文件才让
 * 位一拍，一拍里可能含几十条全表扫描）。state 是普通小行表，按主键查 rowid 是
 * O(log n)，配对后 fts 行按 rowid 删也是 O(log n)。写路径全部走「同一事务里先动
 * state 再按其 rowid 动 fts」维持配对；升级迁移见 db.ts 的 vault_fts_rowid_paired。
 */
function stateRowId(db: SqliteDb, vaultId: string, normPath: string): number | undefined {
  const row = db.prepare(
    'SELECT rowid AS rid FROM vault_files_state WHERE vault_id = ? AND file_path = ?',
  ).get(vaultId, normPath) as { rid: number } | undefined;
  return row?.rid;
}

export function indexVaultFile(db: SqliteDb, vaultId: string, vaultPath: string, relPath: string): void {
  const norm = relPath.replace(/\\/g, '/');
  const resolved = path.resolve(path.join(vaultPath, norm));
  assertWithinVault(vaultPath, resolved);

  const apply = db.transaction(() => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      removeVaultFile(db, vaultId, norm);
      return;
    }
    if (!stat.isFile() || !isIndexableExt(norm) || stat.size > MAX_INDEX_FILE_BYTES) {
      removeVaultFile(db, vaultId, norm);
      return;
    }
    const mtime = Math.floor(stat.mtimeMs);
    const shadow = db.prepare(
      'SELECT rowid AS rid, mtime, size FROM vault_files_state WHERE vault_id = ? AND file_path = ?',
    ).get(vaultId, norm) as { rid: number; mtime: number; size: number } | undefined;
    if (shadow && shadow.mtime === mtime && shadow.size === stat.size) return; // 未变，跳过重读

    let content: string;
    try {
      content = fs.readFileSync(resolved, 'utf-8');
    } catch {
      removeVaultFile(db, vaultId, norm);
      return;
    }
    // 先写 state（新文件 INSERT 得到新 rowid，已存在则 upsert 保 rowid 不变），
    // 再以 state 行的 rowid 作为 fts 行的 rowid 插入——见函数组头注释的配对约定。
    db.prepare(`INSERT INTO vault_files_state(vault_id, file_path, mtime, size) VALUES (?, ?, ?, ?)
                ON CONFLICT(vault_id, file_path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size`)
      .run(vaultId, norm, mtime, stat.size);
    if (shadow) {
      db.prepare('DELETE FROM vault_files_fts WHERE rowid = ?').run(shadow.rid);
    }
    db.prepare('INSERT INTO vault_files_fts(rowid, content, vault_id, file_path) VALUES (?, ?, ?, ?)')
      .run(stateRowId(db, vaultId, norm), content, vaultId, norm);
  });
  apply();
}

export function removeVaultFile(db: SqliteDb, vaultId: string, relPath: string): void {
  // 先查 state（主键 O(log n)）：没有 state 行就不可能有 fts 行（两者同一事务写/删，
  // 见配对约定）。直接返回——这条 O(1) 早退是 walk 里图片/PDF 触发的海量 no-op
  // 删除风暴的关键：旧实现两条按 UNINDEXED 列的 DELETE 每条都是 fts 全表扫描。
  const rid = stateRowId(db, vaultId, relPath);
  if (rid === undefined) return;
  const apply = db.transaction(() => {
    db.prepare('DELETE FROM vault_files_fts WHERE rowid = ?').run(rid);
    db.prepare('DELETE FROM vault_files_state WHERE rowid = ?').run(rid);
  });
  apply();
}

export function removeVaultDir(db: SqliteDb, vaultId: string, dirRelPath: string): void {
  const norm = dirRelPath.replace(/\\/g, '/').replace(/\/+$/, '');
  // LIKE 里的 % 和 _ 是通配符——目录名可能含 `_`（如 a_b），不转义会误删
  // 同模式的兄弟目录（a_b 会匹配 axb）。转义 + ESCAPE 让前缀按字面匹配。
  const escaped = norm.replace(/[\\%_]/g, '\\$&');
  const subtree = "file_path = ? OR file_path LIKE ? ESCAPE '\\'";
  // 先在 state（小行表，扫描毫秒级）圈出子树 rowid，再按 rowid 出 fts——fts 上按
  // UNINDEXED 列 LIKE 前缀删同样是全表扫描（见配对约定头注释）。
  const rids = db.prepare(
    `SELECT rowid AS rid FROM vault_files_state WHERE vault_id = ? AND (${subtree})`,
  ).all(vaultId, norm, escaped + '/%') as Array<{ rid: number }>;
  const apply = db.transaction(() => {
    const delFts = db.prepare('DELETE FROM vault_files_fts WHERE rowid = ?');
    for (const { rid } of rids) delFts.run(rid);
    db.prepare(`DELETE FROM vault_files_state WHERE vault_id = ? AND (${subtree})`)
      .run(vaultId, norm, escaped + '/%');
  });
  apply();
}

/**
 * 每处理多少个文件让出一次事件循环。50 ≈ 单次阻塞 60ms（mac 实测冷索引
 * 1.26ms/文件），既保住 HTTP 响应性又不把总耗时摊掉太多。
 */
export const INDEX_YIELD_EVERY_FILES = 50;

/** 让出事件循环一拍：setImmediate 走 check 阶段，排在已就绪的定时器/IO 之后。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ReindexOpts {
  maxTotal?: number;
  /** 每多少个文件让位一次（默认 INDEX_YIELD_EVERY_FILES；0 = 不让位，仅供测试对照）。 */
  yieldEvery?: number;
  /** 返回 true 即在下一个文件前收工（daemon 关停时别拖着跑完整库）。 */
  shouldStop?: () => boolean;
}

/**
 * 全量/增量重建一个 vault 的索引。与 scanTree 同款剪枝语义（isPrunedDirName +
 * 每目录 MAX_DIR_ENTRIES + MAX_TOTAL 截断）。未变文件经 indexVaultFile 内部的
 * 影子表判变只 stat 不重读；影子表里已消失的路径（外部/agent 删除）在此收尾清除。
 *
 * 异步分片：每 INDEX_YIELD_EVERY_FILES 个文件让出一次事件循环（每文件一个事务，
 * 事务不跨 await）。调用方必须 await——否则拿到的 indexed/removed 是半成品。
 */
export async function reindexVault(
  db: SqliteDb, vaultId: string, vaultPath: string, opts: ReindexOpts = {},
): Promise<{ indexed: number; removed: number }> {
  const maxTotal = opts.maxTotal ?? MAX_TOTAL;
  const yieldEvery = opts.yieldEvery ?? INDEX_YIELD_EVERY_FILES;
  const shouldStop = opts.shouldStop ?? (() => false);
  const seen = new Set<string>();
  let indexed = 0;
  let processed = 0;

  const walk = async (absDir: string, relBase: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length > MAX_DIR_ENTRIES) return; // 与 scanTree 同款：超大目录不进
    for (const entry of entries) {
      if (shouldStop()) return;
      if (seen.size >= maxTotal) return;
      if (isPrunedDirName(entry.name)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        seen.add(rel);
        const before = db.prepare(
          'SELECT mtime, size FROM vault_files_state WHERE vault_id = ? AND file_path = ?',
        ).get(vaultId, rel) as { mtime: number; size: number } | undefined;
        indexVaultFile(db, vaultId, vaultPath, rel);
        const after = db.prepare(
          'SELECT mtime, size FROM vault_files_state WHERE vault_id = ? AND file_path = ?',
        ).get(vaultId, rel) as { mtime: number; size: number } | undefined;
        if (after && (!before || before.mtime !== after.mtime || before.size !== after.size)) indexed++;
        processed++;
        // 分片让位点：让 HTTP/SSE/定时器在整库索引期间照常跑（见文件头注释）。
        if (yieldEvery > 0 && processed % yieldEvery === 0) await yieldToEventLoop();
      }
    }
  };
  await walk(vaultPath, '');

  // 收尾清除外部/agent 删掉的路径：同一批一个事务（比逐文件自动提交快），
  // 同样分片让位——一次性删掉几千文件时不能独占事件循环。
  const known = db.prepare('SELECT file_path FROM vault_files_state WHERE vault_id = ?')
    .all(vaultId) as Array<{ file_path: string }>;
  const stale = known.map((r) => r.file_path).filter((p) => !seen.has(p));
  const removed = stale.length;
  if (removed > 0) {
    const batch = db.transaction((paths: string[]) => {
      for (const p of paths) removeVaultFile(db, vaultId, p);
    });
    const chunk = yieldEvery > 0 ? yieldEvery : removed;
    for (let i = 0; i < removed; i += chunk) {
      if (i > 0) await yieldToEventLoop();
      batch(stale.slice(i, i + chunk));
    }
  }
  return { indexed, removed };
}

/**
 * 同一 vault 的索引构建去重表（按 db 实例隔离——测试各开各库，互不串）。
 *
 * 为什么必须去重：构建分片让位后不再独占线程，「启动预索引」「tree-changed
 * sweep」「首搜建库」「目录改名后重建」可能同时落到同一个 vault 上。后果有两层：
 * 重复 walk 只是浪费 CPU；更要命的是并发构建会互相踩——一个先启动的构建在收尾
 * 时按「我这轮没走到的路径」清理影子表，会把另一个构建刚写进去的行删掉（静默漏
 * 结果）；搜索也会读到半成品索引（构建途中影子表已有行，`seeded` 判据通过）。
 * 同步构建时代不存在这些：构建是原子的，谁也插不进谁中间。
 *
 * 因此把**全部**构建收进这条单行道：同一 vault 同一时刻只有一次 walk，并发方
 * 共享同一份**完整**构建。代价是并发方可能要等（几秒级冷索引），比静默漏强。
 */
const inflightBuilds = new WeakMap<SqliteDb, Map<string, Promise<void>>>();

/** 该 vault 是否有正在跑的构建——搜索要先等它，别读半成品。 */
export function hasInflightBuild(db: SqliteDb, vaultId: string): Promise<void> | undefined {
  return inflightBuilds.get(db)?.get(vaultId);
}

/**
 * 单行道登记口：该 vault 上已有构建在跑就并入它，否则把 `run` 登记为本轮构建。
 * 所有会 walk 整库的入口都必须走这里（首搜建库 / sweep / 目录改名后重建 /
 * 灾难恢复重建），否则又会出现两个 walk 互相踩。
 *
 * 令牌取 vaultId 而非 (vaultId, path)：path 不是独立输入——所有调用方都从
 * vaults 行取（sweep 也每次重读），让它参与令牌反而会在「同一 vault 两个 path」
 * 这种异常态下放两个 walk 并行，正是要消灭的踩踏。宁可多等，不可并行。
 */
function registerBuild(
  db: SqliteDb, vaultId: string, run: () => Promise<unknown>,
): Promise<void> {
  let byVault = inflightBuilds.get(db);
  if (!byVault) {
    byVault = new Map<string, Promise<void>>();
    inflightBuilds.set(db, byVault);
  }
  const running = byVault.get(vaultId);
  if (running) return running;
  const task = run().then(() => undefined);
  byVault.set(vaultId, task);
  // 无论成败都摘掉登记——失败要让后来的调用重新发起，而不是永远等一个已 reject 的 promise。
  const done = (): void => { if (byVault.get(vaultId) === task) byVault.delete(vaultId); };
  void task.then(done, done);
  return task;
}

/** 等（没有则触发）一次全量构建；并发调用共享同一次构建。 */
export function ensureVaultIndexed(
  db: SqliteDb, vaultId: string, vaultPath: string, opts: ReindexOpts = {},
): Promise<void> {
  return registerBuild(db, vaultId, () => reindexVault(db, vaultId, vaultPath, opts));
}

/**
 * 灾难恢复：清空全部 vault 的文件索引后按 vaults 表逐个重建。
 * 单个 vault 目录不可达（卸载的盘等）跳过，不拖垮整体。
 * 逐 vault 顺序 await（分片让位），重建期间 daemon 仍可响应。
 *
 * 清空与重建必须在同一次登记里：清空后被别的构建插进来的话，那次构建
 * 「已经走过的文件」不会再回头重读（影子表已空）→ 索引残缺。故先等在跑的
 * 构建收工，再走单行道。极端情况下若等完后立刻又被并入（期间有人拿到登记），
 * 清空会被跳过——但给出的仍是一份完整索引，用户可重试。
 */
export async function rebuildVaultFtsAll(db: SqliteDb, opts: ReindexOpts = {}): Promise<{ vaults: number }> {
  const vaults = db.prepare('SELECT id, path FROM vaults').all() as Array<{ id: string; path: string }>;
  let n = 0;
  for (const v of vaults) {
    try {
      await hasInflightBuild(db, v.id);
      await registerBuild(db, v.id, async () => {
        // 清空走 rowid 配对约定（fts 上按 vault_id DELETE 是全表扫描，见函数组头注释）
        const rids = db.prepare('SELECT rowid AS rid FROM vault_files_state WHERE vault_id = ?')
          .all(v.id) as Array<{ rid: number }>;
        db.transaction(() => {
          const delFts = db.prepare('DELETE FROM vault_files_fts WHERE rowid = ?');
          for (const { rid } of rids) delFts.run(rid);
          db.prepare('DELETE FROM vault_files_state WHERE vault_id = ?').run(v.id);
        })();
        await reindexVault(db, v.id, v.path, opts);
      });
      n++;
    } catch {
      // 目录不可达——跳过
    }
  }
  return { vaults: n };
}

function sanitizeFtsQuery(query: string): { phrase: string; trimmed: string } {
  const trimmed = query.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return { phrase: `"${trimmed.replace(/"/g, '""')}"`, trimmed };
}

/**
 * vault 全文搜索（替代 knowledge.ts 的 walk+includes searchFiles）。
 * - 首搜建库：影子表为空 = 该 vault 从未索引，reindexVault（成本 ≈ 旧实现
 *   每次搜索的 walk，一次性支付）。构建分片让位——本次搜索请求会等它跑完，
 *   但 daemon 不会因此卡住别的请求（含 Web UI 自己的静态资源）。
 * - ≥3 字符：FTS5 短语查询（净化同 searchConversationIds）+ bm25 升序 + snippet。
 * - <3 字符：trigram 无法成串，对 fts 表 content LIKE 回退（无 bm25，路径稳定序）。
 * - 惰性校验：逐命中 stat——ENOENT 出索引并剔除；mtime/size 变了重索引该文件且
 *   整榜重查一轮（只重试一次，防循环）。
 */
export async function searchVaultFiles(
  db: SqliteDb, vaultId: string, vaultPath: string, query: string, limit = 20,
): Promise<{ results: SearchResult[]; truncated: boolean }> {
  const { phrase, trimmed } = sanitizeFtsQuery(query);
  if (!trimmed) return { results: [], truncated: false };

  // 有 in-flight 构建先等它：分片构建途中影子表已有行，光看 seeded 会查到半成品
  // （静默漏结果）。该 vault 从未建过库才由本请求触发一次构建。
  const building = hasInflightBuild(db, vaultId);
  if (building) await building;
  else if (!db.prepare('SELECT 1 FROM vault_files_state WHERE vault_id = ? LIMIT 1').get(vaultId)) {
    await ensureVaultIndexed(db, vaultId, vaultPath);
  }

  const runQuery = (): Array<{ file_path: string; snip: string }> => {
    if (trimmed.length < 3) {
      // snippet 取匹配处 ±30（与旧 searchFiles 一致）——SearchPanel 靠 snippet 内
      // indexOf 高亮关键词，若取文件开头则 2 字中文查询（旗舰场景）的高亮全失效。
      const like = `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`;
      return db.prepare(
        `SELECT file_path,
                substr(content, max(1, instr(content, ?) - 30), length(?) + 60) AS snip
         FROM vault_files_fts
         WHERE vault_id = ? AND content LIKE ? ESCAPE '\\'
         ORDER BY file_path LIMIT ?`,
      ).all(trimmed, trimmed, vaultId, like, limit + 1) as Array<{ file_path: string; snip: string }>;
    }
    return db.prepare(
      `SELECT file_path, snippet(vault_files_fts, 0, '', '', '…', 24) AS snip
       FROM vault_files_fts WHERE vault_files_fts MATCH ? AND vault_id = ?
       ORDER BY bm25(vault_files_fts) LIMIT ?`,
    ).all(phrase, vaultId, limit + 1) as Array<{ file_path: string; snip: string }>;
  };

  let rows = runQuery();
  let retried = false;
  const vaultRoot = path.resolve(vaultPath);
  for (let i = rows.length - 1; i >= 0; i--) {
    const rel = rows[i]!.file_path;
    const resolved = path.resolve(path.join(vaultPath, rel));
    if (resolved !== vaultRoot && !resolved.startsWith(vaultRoot + path.sep)) {
      rows.splice(i, 1); // 索引被污染的防御：路径出库的直接剔掉
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      removeVaultFile(db, vaultId, rel); // 外部删除：出结果 + 出索引
      rows.splice(i, 1);
      continue;
    }
    const shadow = db.prepare('SELECT mtime, size FROM vault_files_state WHERE vault_id = ? AND file_path = ?')
      .get(vaultId, rel) as { mtime: number; size: number } | undefined;
    if (shadow && (shadow.mtime !== Math.floor(stat.mtimeMs) || shadow.size !== stat.size)) {
      indexVaultFile(db, vaultId, vaultPath, rel); // 外部修改：重索引这一份
      if (!retried) { rows = runQuery(); retried = true; } // 内容可能变了，整榜重查一次
    }
  }

  const results = rows.slice(0, limit).map((r) => ({
    filePath: r.file_path,
    fileName: r.file_path.split('/').pop() ?? r.file_path,
    snippet: r.snip.replace(/\s+/g, ' ').trim(),
  }));
  return { results, truncated: rows.length > limit };
}

/**
 * 后台索引新鲜度巡检（检索 P0 层 1 的「活库」地基）。
 *
 * 为什么需要它：写路径挂钩（routes/knowledge.ts）只覆盖经 Molio API 的写入；
 * agent（Claude Code 的 Write/Edit）与外部编辑器直写磁盘不经过那些函数，搜索时
 * 惰性校验又只复核「已命中」的文件——新文件在 sweep 前根本不会被发现。本类订阅
 * VaultWatcher 的 tree-changed（外部/agent 落盘会触发 chokidar），按 vault 防抖
 * 合并后跑一次 reindexVault（stat-only walk，未变文件不重读）。启动时 scheduleAll
 * 给已挂载的 vault 各排一次，补齐 daemon 停机期间的外部改动。
 */
/** scheduleAll 里相邻 vault 预索引之间的错峰间隔（毫秒）。 */
const STAGGER_MS = 250;

export class VaultIndexSweeper {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每个 vault 正在跑的 sweep。分片异步后同一 vault 可能被并发触发，必须去重。 */
  private running = new Map<string, Promise<void>>();
  /** 正在跑的 sweep 期间又收到 tree-changed 的 vault——跑完立刻补一次，不丢改动。 */
  private dirty = new Set<string>();
  private stopped = false;
  private readonly debounceMs: number;

  constructor(private readonly db: SqliteDb, opts: { debounceMs?: number } = {}) {
    this.debounceMs = opts.debounceMs ?? 4000;
  }

  /** 排一次防抖 sweep；同 vault 连续触发合并为一次（重置定时器）。 */
  scheduleVault(vaultId: string, extraDelayMs = 0): void {
    if (this.stopped) return;
    const existing = this.timers.get(vaultId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(vaultId);
      void this.sweepVaultNow(vaultId);
    }, this.debounceMs + extraDelayMs);
    t.unref?.();
    this.timers.set(vaultId, t);
  }

  /**
   * 启动预索引：对 vaults 表里全部 vault 各排一次，逐个顺延 STAGGER_MS 错峰
   * （不阻塞 listen）。构建本身是分片异步的（不独占事件循环），错峰只是让
   * NAS/网络挂载上的 stat 不至于同时涌入。
   */
  scheduleAll(): void {
    const rows = this.db.prepare('SELECT id FROM vaults').all() as Array<{ id: string }>;
    rows.forEach(({ id }, i) => this.scheduleVault(id, i * STAGGER_MS));
  }

  /**
   * 扫一个 vault（测试/立即刷新入口）。vault 不存在或目录不可达则静默跳过。
   * 同一 vault 已有 sweep 在跑时不并发：登记 dirty 并返回同一个 in-flight
   * promise（调用方可安全 await，不会拿到半成品）。
   *
   * 刻意不写成 async 方法——async 每次调用都包一层新 promise，
   * 「同一 vault 返回同一个 promise」这个去重语义就没了。
   */
  sweepVaultNow(vaultId: string): Promise<void> {
    // 关停后不再起新构建（与 scheduleVault 同款门禁）：否则会登记一次必被
    // shouldStop 掐断的 walk，还可能撞上 closeDatabase 后的连接。
    if (this.stopped) return Promise.resolve();
    const inflight = this.running.get(vaultId);
    if (inflight) {
      this.dirty.add(vaultId);
      return inflight;
    }
    const task = this.runSweep(vaultId).then(
      () => this.finishSweep(vaultId),
      () => this.finishSweep(vaultId),
    );
    this.running.set(vaultId, task);
    return task;
  }

  private async runSweep(vaultId: string): Promise<void> {
    const vault = getVault(this.db, vaultId);
    if (!vault) return;
    try {
      // ensureVaultIndexed：并发方（首搜建库等）共享同一份构建，不重复 walk。
      // shouldStop：关停时别拖着跑完整库（daemon 会在 gracefulShutdown 里
      // closeDatabase，索引器必须尽快收工，否则后续语句打在已关的连接上）。
      await ensureVaultIndexed(this.db, vaultId, vault.path, { shouldStop: () => this.stopped });
    } catch {
      // 目录不可达 / 关停竞态——下次 tree-changed 再试，不打断服务
    }
  }

  private finishSweep(vaultId: string): void {
    this.running.delete(vaultId);
    if (this.dirty.delete(vaultId) && !this.stopped) void this.sweepVaultNow(vaultId);
  }

  /** 清定时器（server 优雅关停调用）。stop 后 scheduleVault 不再排新任务，
   *  在跑的 sweep 也在下一个文件前收工。 */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.dirty.clear();
  }
}
