/**
 * Knowledge Base API routes — vault CRUD + file operations + wiki build.
 */

import { Hono } from 'hono';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  CreateVaultRequest,
  WikiBuildRequest,
  WikiIngestRequest,
  WikiLintRequest,
  WikiQueryRequest,
  WikiSaveRequest,
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
  resolveFilePath,
  writeFile,
  deleteFile,
  createDirectory,
  deleteDirectory,
  renamePath,
  ensureVaultDir,
} from '../core/knowledge.js';
import type { RunManager } from '../core/RunManager.js';
import { installBuiltinSkills } from '../core/skill-installer.js';
import {
  WIKI_BUILD_PROMPT,
  WIKI_INGEST_PROMPT,
  WIKI_LINT_PROMPT,
  WIKI_QUERY_PROMPT,
  WIKI_SAVE_PROMPT,
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
      installBuiltinSkills(body.path);
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

  // PUT /api/knowledge/vaults/:id/files/* — rename a file
  app.put('/vaults/:id/files/*', async (c) => {
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
      const body = await c.req.json<{ newPath: string }>();
      if (!body.newPath) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'newPath is required' } }, 400);
      }
      renamePath(vault.path, relPath, body.newPath);
      addKbHistory(db, vault.id, 'edit', `Renamed "${relPath}" → "${body.newPath}"`);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rename file';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // ─── Raw file serving (for images, PDFs, etc.) ───

  // GET /api/knowledge/vaults/:id/raw/* — serve raw file with proper Content-Type
  app.get('/vaults/:id/raw/*', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const fullPath = c.req.path;
    const prefix = `/api/knowledge/vaults/${vault.id}/raw/`;
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));

    if (!relPath) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'File path is required' } }, 400);
    }

    try {
      const absPath = resolveFilePath(vault.path, relPath);
      const stream = createReadStream(absPath);
      const ext = path.extname(absPath).toLowerCase();
      const mime = RAW_MIME[ext] ?? 'application/octet-stream';

      return new Response(stream as any, {
        headers: { 'Content-Type': mime },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file';
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

  // DELETE /api/knowledge/vaults/:id/dirs/* — delete a directory
  app.delete('/vaults/:id/dirs/*', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const fullPath = c.req.path;
    const prefix = `/api/knowledge/vaults/${vault.id}/dirs/`;
    const relPath = decodeURIComponent(fullPath.slice(prefix.length));

    if (!relPath) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Directory path is required' } }, 400);
    }

    try {
      deleteDirectory(vault.path, relPath);
      addKbHistory(db, vault.id, 'edit', `Directory "${relPath}" deleted`);
      return c.body(null, 204);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete directory';
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

    const indexExists = existsSync(path.join(vault.path, 'wiki', 'INDEX.md'));
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

      const message = `${WIKI_BUILD_PROMPT}\n\n---\n\n请现在开始构建 Wiki。扫描 vault 中所有源文件并创建 wiki。`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      addKbHistory(db, vault.id, 'ingest', 'Wiki 构建已启动');
      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '启动 Wiki 构建失败';
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

      const message = `${WIKI_INGEST_PROMPT}\n\n---\n\n请将以下文件导入 wiki：${body.filePath}`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      addKbHistory(db, vault.id, 'ingest', `已导入 "${body.filePath}"`);
      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '导入文件失败';
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

      const message = `${WIKI_LINT_PROMPT}\n\n---\n\n请现在对 wiki 进行健康检查。`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      addKbHistory(db, vault.id, 'lint', 'Wiki 健康检查已启动');
      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '启动 Wiki 健康检查失败';
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

      const message = `${WIKI_QUERY_PROMPT}\n\n---\n\n用户问题：${body.message}`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '启动 Wiki 查询失败';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // POST /api/knowledge/vaults/:id/wiki/save — save conversation to wiki
  app.post('/vaults/:id/wiki/save', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const body = await c.req.json<WikiSaveRequest>();
      if (!body.agentId) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId is required' } }, 400);
      }

      const userContext = body.message ?? '请回顾当前对话，将值得归档的内容保存为 wiki 页面。';
      const message = `${WIKI_SAVE_PROMPT}\n\n---\n\n${userContext}`;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: vault.path,
      });

      addKbHistory(db, vault.id, 'edit', 'Wiki 归档已启动');
      return c.json({ runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '启动 Wiki 归档失败';
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

const RAW_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
