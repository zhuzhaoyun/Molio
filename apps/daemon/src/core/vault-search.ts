/**
 * Vault 文件全文索引（检索 P0 层 1）——索引器。
 * 查询端见本文件 searchVaultFiles；写路径挂钩在 routes/knowledge.ts；
 * 外部/agent 编辑的新鲜度由 VaultIndexSweeper（tree-changed 防抖）+ 搜索时
 * 惰性校验共同保证。设计：docs/2026-10-10-retrieval-p0.md §4.1。
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
      'SELECT mtime, size FROM vault_files_state WHERE vault_id = ? AND file_path = ?',
    ).get(vaultId, norm) as { mtime: number; size: number } | undefined;
    if (shadow && shadow.mtime === mtime && shadow.size === stat.size) return; // 未变，跳过重读

    let content: string;
    try {
      content = fs.readFileSync(resolved, 'utf-8');
    } catch {
      removeVaultFile(db, vaultId, norm);
      return;
    }
    db.prepare('DELETE FROM vault_files_fts WHERE vault_id = ? AND file_path = ?').run(vaultId, norm);
    db.prepare('INSERT INTO vault_files_fts(content, vault_id, file_path) VALUES (?, ?, ?)')
      .run(content, vaultId, norm);
    db.prepare(`INSERT INTO vault_files_state(vault_id, file_path, mtime, size) VALUES (?, ?, ?, ?)
                ON CONFLICT(vault_id, file_path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size`)
      .run(vaultId, norm, mtime, stat.size);
  });
  apply();
}

export function removeVaultFile(db: SqliteDb, vaultId: string, relPath: string): void {
  db.prepare('DELETE FROM vault_files_fts WHERE vault_id = ? AND file_path = ?').run(vaultId, relPath);
  db.prepare('DELETE FROM vault_files_state WHERE vault_id = ? AND file_path = ?').run(vaultId, relPath);
}

export function removeVaultDir(db: SqliteDb, vaultId: string, dirRelPath: string): void {
  const norm = dirRelPath.replace(/\\/g, '/').replace(/\/+$/, '');
  // LIKE 里的 % 和 _ 是通配符——目录名可能含 `_`（如 a_b），不转义会误删
  // 同模式的兄弟目录（a_b 会匹配 axb）。转义 + ESCAPE 让前缀按字面匹配。
  const escaped = norm.replace(/[\\%_]/g, '\\$&');
  db.prepare("DELETE FROM vault_files_fts WHERE vault_id = ? AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')")
    .run(vaultId, norm, escaped + '/%');
  db.prepare("DELETE FROM vault_files_state WHERE vault_id = ? AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')")
    .run(vaultId, norm, escaped + '/%');
}

export interface ReindexOpts { maxTotal?: number }

/**
 * 全量/增量重建一个 vault 的索引。与 scanTree 同款剪枝语义（isPrunedDirName +
 * 每目录 MAX_DIR_ENTRIES + MAX_TOTAL 截断）。未变文件经 indexVaultFile 内部的
 * 影子表判变只 stat 不重读；影子表里已消失的路径（外部/agent 删除）在此收尾清除。
 */
export function reindexVault(
  db: SqliteDb, vaultId: string, vaultPath: string, opts: ReindexOpts = {},
): { indexed: number; removed: number } {
  const maxTotal = opts.maxTotal ?? MAX_TOTAL;
  const seen = new Set<string>();
  let indexed = 0;

  const walk = (absDir: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length > MAX_DIR_ENTRIES) return; // 与 scanTree 同款：超大目录不进
    for (const entry of entries) {
      if (seen.size >= maxTotal) return;
      if (isPrunedDirName(entry.name)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
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
      }
    }
  };
  walk(vaultPath, '');

  let removed = 0;
  const known = db.prepare('SELECT file_path FROM vault_files_state WHERE vault_id = ?')
    .all(vaultId) as Array<{ file_path: string }>;
  for (const { file_path } of known) {
    if (!seen.has(file_path)) {
      removeVaultFile(db, vaultId, file_path);
      removed++;
    }
  }
  return { indexed, removed };
}

/**
 * 灾难恢复：清空全部 vault 的文件索引后按 vaults 表逐个重建。
 * 单个 vault 目录不可达（卸载的盘等）跳过，不拖垮整体。
 */
export function rebuildVaultFtsAll(db: SqliteDb): { vaults: number } {
  const vaults = db.prepare('SELECT id, path FROM vaults').all() as Array<{ id: string; path: string }>;
  let n = 0;
  for (const v of vaults) {
    const clear = db.transaction(() => {
      db.prepare('DELETE FROM vault_files_fts WHERE vault_id = ?').run(v.id);
      db.prepare('DELETE FROM vault_files_state WHERE vault_id = ?').run(v.id);
    });
    clear();
    try {
      reindexVault(db, v.id, v.path);
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
 * - 首搜建库：影子表为空 = 该 vault 从未索引，同步 reindexVault（成本 ≈ 旧实现
 *   每次搜索的 walk，一次性支付）。
 * - ≥3 字符：FTS5 短语查询（净化同 searchConversationIds）+ bm25 升序 + snippet。
 * - <3 字符：trigram 无法成串，对 fts 表 content LIKE 回退（无 bm25，路径稳定序）。
 * - 惰性校验：逐命中 stat——ENOENT 出索引并剔除；mtime/size 变了重索引该文件且
 *   整榜重查一轮（只重试一次，防循环）。
 */
export function searchVaultFiles(
  db: SqliteDb, vaultId: string, vaultPath: string, query: string, limit = 20,
): { results: SearchResult[]; truncated: boolean } {
  const { phrase, trimmed } = sanitizeFtsQuery(query);
  if (!trimmed) return { results: [], truncated: false };

  const seeded = db.prepare('SELECT 1 FROM vault_files_state WHERE vault_id = ? LIMIT 1').get(vaultId);
  if (!seeded) reindexVault(db, vaultId, vaultPath);

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
      this.sweepVaultNow(vaultId);
    }, this.debounceMs + extraDelayMs);
    t.unref?.();
    this.timers.set(vaultId, t);
  }

  /**
   * 启动预索引：对 vaults 表里全部 vault 各排一次，逐个顺延 STAGGER_MS 错峰
   * （不阻塞 listen）。reindexVault 是同步全量 walk——若所有 vault 在同一 tick
   * 触发，多库场景会在启动后同时涌入一串完整 walk，长阻塞事件循环（NAS/网络
   * 挂载的 /vaults 上 stat 不免费）。错峰把并发收敛为串行。
   */
  scheduleAll(): void {
    const rows = this.db.prepare('SELECT id FROM vaults').all() as Array<{ id: string }>;
    rows.forEach(({ id }, i) => this.scheduleVault(id, i * STAGGER_MS));
  }

  /** 同步扫一个 vault（测试/立即刷新入口）。vault 不存在或目录不可达则静默跳过。 */
  sweepVaultNow(vaultId: string): void {
    const vault = getVault(this.db, vaultId);
    if (!vault) return;
    try {
      reindexVault(this.db, vaultId, vault.path);
    } catch {
      // 目录不可达等——下次 tree-changed 再试，不打断服务
    }
  }

  /** 清定时器（server 优雅关停调用）。stop 后 scheduleVault 不再排新任务。 */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
