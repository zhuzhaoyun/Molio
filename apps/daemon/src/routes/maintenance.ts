import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { rebuildMessagesFts } from '../core/db.js';
import { rebuildVaultFtsAll } from '../core/vault-search.js';

export function maintenanceRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // POST /api/maintenance/rebuild-fts — disaster-recovery: repopulate
  // messages_fts from messages. Local-only; not exposed to external networks.
  app.post('/rebuild-fts', (c) => {
    try {
      rebuildMessagesFts(db);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: { code: 'REBUILD_FAILED', message: (err as Error).message } }, 500);
    }
  });

  // POST /api/maintenance/rebuild-vault-fts — 同上定位，重建 vault 文件索引
  // （检索 P0 层 1）。清空 + 按 vaults 表逐个 reindex，用于迁移/修数据。
  app.post('/rebuild-vault-fts', (c) => {
    try {
      const { vaults } = rebuildVaultFtsAll(db);
      return c.json({ ok: true, vaults });
    } catch (err) {
      return c.json({ error: { code: 'REBUILD_FAILED', message: (err as Error).message } }, 500);
    }
  });

  return app;
}