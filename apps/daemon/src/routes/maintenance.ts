import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { rebuildMessagesFts } from '../core/db.js';

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

  return app;
}