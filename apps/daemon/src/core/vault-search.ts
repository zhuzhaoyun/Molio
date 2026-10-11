/**
 * Vault 文件全文索引（检索 P0 层 1）——索引器。
 * 查询端见本文件 searchVaultFiles；写路径挂钩在 routes/knowledge.ts；
 * 外部/agent 编辑的新鲜度由 VaultIndexSweeper（tree-changed 防抖）+ 搜索时
 * 惰性校验共同保证。设计：docs/2026-10-10-retrieval-p0.md §4.1。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SqliteDb } from './db.js';
import { TEXT_EXTS } from './knowledge.js';

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
  const prefix = dirRelPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  db.prepare("DELETE FROM vault_files_fts WHERE vault_id = ? AND (file_path = ? OR file_path LIKE ?)")
    .run(vaultId, prefix.slice(0, -1), prefix + '%');
  db.prepare("DELETE FROM vault_files_state WHERE vault_id = ? AND (file_path = ? OR file_path LIKE ?)")
    .run(vaultId, prefix.slice(0, -1), prefix + '%');
}
