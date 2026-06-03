/**
 * Knowledge Base API routes — vault CRUD + file operations.
 */

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { CreateVaultRequest } from '@kge/contracts';
import {
  listVaults,
  getVault,
  createVault,
  deleteVault,
  listKbHistory,
  addKbHistory,
} from '../core/db.js';
import {
  scanTree,
  countFiles,
  readFile,
  writeFile,
  deleteFile,
  createDirectory,
  ensureVaultDir,
} from '../core/knowledge.js';

export function knowledgeRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // ─── Vaults ───

  // GET /api/knowledge/vaults — list all vaults
  app.get('/vaults', (c) => {
    const vaults = listVaults(db).map((v) => ({
      ...v,
      fileCount: countFilesSafe(v.path),
    }));
    return c.json({ vaults });
  });

  // POST /api/knowledge/vaults — create a vault
  app.post('/vaults', async (c) => {
    const body = await c.req.json<CreateVaultRequest>();
    if (!body.name || !body.path) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'name and path are required' } }, 400);
    }

    try {
      ensureVaultDir(body.path);
      const vault = createVault(db, body.name, body.path, body.description);
      addKbHistory(db, vault.id, 'edit', `Vault "${vault.name}" created`);
      return c.json({ ...vault, fileCount: 0 }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create vault';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // DELETE /api/knowledge/vaults/:id — delete vault metadata (not files)
  app.delete('/vaults/:id', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }
    deleteVault(db, c.req.param('id'));
    return c.body(null, 204);
  });

  // ─── File tree ───

  // GET /api/knowledge/vaults/:id/tree — scan vault directory tree
  app.get('/vaults/:id/tree', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const tree = scanTree(vault.path);
      return c.json({ tree });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to scan vault';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // ─── File content ───

  // GET /api/knowledge/vaults/:id/files/* — read a file
  app.get('/vaults/:id/files/*', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    // Extract relative path from the wildcard segment
    const fullPath = c.req.path;
    const prefix = `/api/knowledge/vaults/${vault.id}/files/`;
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));

    if (!relPath) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'File path is required' } }, 400);
    }

    try {
      const file = readFile(vault.path, relPath);
      return c.json(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // POST /api/knowledge/vaults/:id/files/* — write/create a file
  app.post('/vaults/:id/files/*', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const fullPath = c.req.path;
    const prefix = `/api/knowledge/vaults/${vault.id}/files/`;
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));

    if (!relPath) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'File path is required' } }, 400);
    }

    try {
      const body = await c.req.json<{ content: string }>();
      writeFile(vault.path, relPath, body.content);
      addKbHistory(db, vault.id, 'edit', `File "${relPath}" saved`);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to write file';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // DELETE /api/knowledge/vaults/:id/files/* — delete a file
  app.delete('/vaults/:id/files/*', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const fullPath = c.req.path;
    const prefix = `/api/knowledge/vaults/${vault.id}/files/`;
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));

    if (!relPath) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'File path is required' } }, 400);
    }

    try {
      deleteFile(vault.path, relPath);
      addKbHistory(db, vault.id, 'edit', `File "${relPath}" deleted`);
      return c.body(null, 204);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete file';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // ─── Directory creation ───

  // POST /api/knowledge/vaults/:id/dirs/* — create a directory
  app.post('/vaults/:id/dirs/*', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const fullPath = c.req.path;
    const prefix = `/api/knowledge/vaults/${vault.id}/dirs/`;
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));

    try {
      createDirectory(vault.path, relPath);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create directory';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // ─── History ───

  // GET /api/knowledge/vaults/:id/history — list vault history
  app.get('/vaults/:id/history', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const limit = Number(c.req.query('limit') ?? '50');
    const history = listKbHistory(db, vault.id, limit);
    return c.json({ history });
  });

  return app;
}

/** Safe count — return 0 if vault path doesn't exist yet. */
function countFilesSafe(vaultPath: string): number {
  try {
    return countFiles(vaultPath);
  } catch {
    return 0;
  }
}
