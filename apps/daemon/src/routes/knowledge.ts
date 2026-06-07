/**
 * Knowledge Base API routes — vault CRUD + file operations + wiki build.
 */

import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  CreateVaultRequest,
  WikiBuildRequest,
  WikiIngestRequest,
  WikiLintRequest,
  WikiQueryRequest,
} from '@molio/contracts';
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
import type { RunManager } from '../core/RunManager.js';
import {
  WIKI_BUILD_PROMPT,
  WIKI_INGEST_PROMPT,
  WIKI_LINT_PROMPT,
  WIKI_QUERY_PROMPT,
} from '../core/wiki-prompts.js';

export function knowledgeRoutes(db: Database.Database, runManager: RunManager): Hono {
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

  // ─── Wiki ───

  // GET /api/knowledge/vaults/:id/wiki/status — check wiki initialization status
  app.get('/vaults/:id/wiki/status', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const indexExists = existsSync(path.join(vault.path, 'INDEX.md'));
    const wikiDirExists = existsSync(path.join(vault.path, 'wiki'));

    return c.json({
      initialized: indexExists,
      indexExists,
      wikiDirExists,
    });
  });

  // POST /api/knowledge/vaults/:id/wiki/build — trigger wiki build
  app.post('/vaults/:id/wiki/build', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const body = await c.req.json<WikiBuildRequest>();
      if (!body.agentId) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId is required' } }, 400);
      }

      const message = `${WIKI_BUILD_PROMPT}\n\n---\n\nBegin the wiki build now. Scan all source files in this vault and create the wiki.`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      addKbHistory(db, vault.id, 'ingest', 'Wiki build started');
      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start wiki build';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // POST /api/knowledge/vaults/:id/wiki/ingest — ingest a file or directory
  app.post('/vaults/:id/wiki/ingest', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const body = await c.req.json<WikiIngestRequest>();
      if (!body.agentId || !body.filePath) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId and filePath are required' } }, 400);
      }

      const message = `${WIKI_INGEST_PROMPT}\n\n---\n\nIngest the following file or directory into the wiki: ${body.filePath}`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      addKbHistory(db, vault.id, 'ingest', `Ingested "${body.filePath}"`);
      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to ingest file';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // POST /api/knowledge/vaults/:id/wiki/lint — run wiki health check
  app.post('/vaults/:id/wiki/lint', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const body = await c.req.json<WikiLintRequest>();
      if (!body.agentId) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId is required' } }, 400);
      }

      const message = `${WIKI_LINT_PROMPT}\n\n---\n\nRun a health check on the wiki now.`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      addKbHistory(db, vault.id, 'lint', 'Wiki health check started');
      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start wiki lint';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // POST /api/knowledge/vaults/:id/wiki/query — ask a question against the wiki
  app.post('/vaults/:id/wiki/query', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const body = await c.req.json<WikiQueryRequest>();
      if (!body.agentId || !body.message) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId and message are required' } }, 400);
      }

      const message = `${WIKI_QUERY_PROMPT}\n\n---\n\nUser question: ${body.message}`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start wiki query';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
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
