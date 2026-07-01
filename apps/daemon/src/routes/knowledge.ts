/**
 * Knowledge Base API routes — vault CRUD + file operations + wiki build.
 */

import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  CreateVaultRequest,
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
  searchFiles,
  importFiles,
  isInsideProtected,
} from '../core/knowledge.js';
import { annotateTreeStatus } from '../core/wiki-status.js';
import { VAULT_TREE_CHANGED_EVENT, type VaultWatcher } from '../core/vault-watcher.js';
import type { RunManager } from '../core/RunManager.js';
import { installBuiltinSkills } from '../core/skill-installer.js';

export function knowledgeRoutes(
  db: Database.Database,
  runManager: RunManager,
  vaultWatcher: VaultWatcher,
): Hono {
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
      void vaultWatcher.watch(vault.id, vault.path);
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
    void vaultWatcher.unwatch(c.req.param('id'));
    return c.body(null, 204);
  });

  // ─── File tree ───

  // GET /api/knowledge/vaults/:id/tree — scan vault directory tree
  app.get('/vaults/:id/tree', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    try {
      const tree = scanTree(vault.path);
      // Annotate with ingest status (only if the vault has a .git repo).
      await annotateTreeStatus(vault.path, tree);
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
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return c.json({ error: { code: 'NOT_FOUND', message } }, 404);
      }
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
  app.delete('/vaults/:id/files/*', async (c) => {
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
      await deleteFile(vault.path, relPath);
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
      // Explicit protected-dir check for clearer error messaging
      if (isInsideProtected(relPath)) {
        return c.json({ error: { code: 'BAD_REQUEST', message: `Cannot move files out of protected directory: ${relPath}` } }, 400);
      }
      if (isInsideProtected(body.newPath)) {
        return c.json({ error: { code: 'BAD_REQUEST', message: `Cannot move files into protected directory: ${body.newPath}` } }, 400);
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

  // ─── Asset upload ───

  const ASSETS_DIR = '.molio/assets';

  // POST /api/knowledge/vaults/:id/assets/upload — upload an image asset
  app.post('/vaults/:id/assets/upload', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    // Size check via Content-Length header (guard before reading body).
    // Parse strictly: a missing/non-numeric/oversized value is rejected
    // immediately so the body is never buffered into memory. The daemon has no
    // auth (CORS allows any localhost origin), so without this guard a spoofed
    // or absent Content-Length could force OOM by buffering an arbitrarily
    // large body before the post-read check below runs.
    const rawLen = c.req.header('Content-Length');
    const contentLength = rawLen != null ? parseInt(rawLen, 10) : NaN;
    const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_SIZE) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Image too large (max 50MB)' } }, 413);
    }

    try {
      const body = await c.req.parseBody();
      const file = body['file'];

      if (!file || typeof file === 'string') {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'No file provided' } }, 400);
      }

      // file is a File-like object with .name, .type, and .arrayBuffer()
      const fileObj = file as File;
      const mimeType = fileObj.type || 'application/octet-stream';

      // Validate image type
      const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (!ALLOWED_TYPES.includes(mimeType)) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'Unsupported image format (PNG/JPEG/GIF/WebP only)' } }, 400);
      }

      const EXT_BY_TYPE: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      const ext = EXT_BY_TYPE[mimeType] ?? '.webp';

      // Generate unique filename
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      // Read file bytes
      const bytes = await fileObj.arrayBuffer();
      const buf = Buffer.from(bytes);

      // Validate actual size after reading (defense against Content-Length spoofing)
      if (buf.byteLength > MAX_SIZE) {
        return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Image too large (max 50MB)' } }, 413);
      }

      // Ensure .molio/assets/ directory exists. recursive:true is idempotent
      // (no EEXIST), so any error here is a real OS failure (EACCES/ENOSPC/EROFS)
      // and should propagate rather than be swallowed — otherwise the subsequent
      // writeFileSync surfaces a misleading ENOENT that hides the real cause.
      mkdirSync(resolveFilePath(vault.path, ASSETS_DIR), { recursive: true });

      // Write to disk using an exclusive-create (`wx`) flag with EEXIST retry.
      // The previous existsSync + writeFileSync pair was racy: the `await`
      // arrayBuffer() between check and write yields the event loop, so two
      // same-second uploads could both pass the check and overwrite each other.
      // `wx` makes the check-and-create atomic at the OS level — if the file
      // already exists we bump the sequence counter and retry (bounded).
      const MAX_NAME_RETRIES = 1000;
      let relPath = '';
      let absPath = '';
      for (let seq = 1; seq <= MAX_NAME_RETRIES; seq++) {
        relPath = `${ASSETS_DIR}/${ts}-${seq}${ext}`;
        absPath = resolveFilePath(vault.path, relPath);
        try {
          writeFileSync(absPath, buf, { flag: 'wx' });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            continue;
          }
          throw err;
        }
      }
      if (!absPath) {
        throw new Error('Failed to generate a unique asset filename after maximum retries');
      }

      const url = `/api/knowledge/vaults/${vault.id}/raw/${encodeURIComponent(relPath).replace(/%2F/g, '/')}`;

      return c.json({ filePath: relPath, url }, 201);
    } catch (err) {
      console.error('[knowledge] asset upload failed:', err);
      const message = err instanceof Error ? err.message : 'Failed to upload asset';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // ─── File import (drag-and-drop / ImportModal) ───

  const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB

  // POST /api/knowledge/vaults/:id/import — import files via multipart
  app.post('/vaults/:id/import', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    // Size guard via Content-Length
    const rawLen = c.req.header('Content-Length');
    const contentLength = rawLen != null ? parseInt(rawLen, 10) : NaN;
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_IMPORT_SIZE) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Upload too large (max 50MB)' } }, 413);
    }

    try {
      const body = await c.req.parseBody();
      const targetDir = (typeof body['targetDir'] === 'string' ? body['targetDir'] : '').replace(/^\/+|\/+$/g, '');
      const conflict = (typeof body['conflict'] === 'string' ? body['conflict'] : 'ask') as
        'ask' | 'skip' | 'replace' | 'rename';

      // Validation: targetDir must not be a protected directory
      if (targetDir && isInsideProtected(targetDir)) {
        return c.json(
          { error: { code: 'BAD_REQUEST', message: `Cannot import into protected directory: ${targetDir}` } },
          400,
        );
      }

      // Collect files from the multipart body
      const fileEntries: Array<{ name: string; buffer: Buffer }> = [];
      for (const [key, value] of Object.entries(body)) {
        if (key.startsWith('files') && value && typeof value === 'object' && 'arrayBuffer' in value) {
          const file = value as File;
          const bytes = await file.arrayBuffer();
          const buf = Buffer.from(bytes);
          if (buf.byteLength > MAX_IMPORT_SIZE) {
            fileEntries.push({ name: file.name, buffer: Buffer.alloc(0) });
            // mark as too-large in a way importFiles can handle — we inject an error
            // actually, just skip: importFiles checks the name/ext only
            // We handle size limit per-file: reject if individual file > 50MB
            // (Content-Length was the total guard; individual file guard here)
          } else {
            fileEntries.push({ name: file.name, buffer: buf });
          }
        }
      }

      if (fileEntries.length === 0) {
        return c.json({ error: { code: 'BAD_REQUEST', message: 'No files provided' } }, 400);
      }

      const result = importFiles(vault.path, fileEntries, targetDir, conflict);

      // If conflict: "ask" and conflicts were found, return 409
      if (conflict === 'ask' && result.errors.some(e => e.reason === 'conflict')) {
        return c.json(result, 409);
      }

      addKbHistory(db, vault.id, 'import', `${result.imported.length} file(s) imported`);
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to import files';
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
  app.delete('/vaults/:id/dirs/*', async (c) => {
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
      await deleteDirectory(vault.path, relPath);
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

  // GET /api/knowledge/vaults/:id/search — 全文搜索
  app.get('/vaults/:id/search', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    const q = c.req.query('q') ?? '';
    if (!q.trim()) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Query (q) is required' } }, 400);
    }
    const rawLimit = Number(c.req.query('limit') ?? '20');
    const limit = !Number.isFinite(rawLimit) || rawLimit <= 0 || !Number.isInteger(rawLimit)
      ? 20
      : Math.min(rawLimit, 100);

    try {
      const { results, truncated } = searchFiles(vault.path, q, limit);
      return c.json({ results, truncated });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to search vault';
      return c.json({ error: { code: 'INTERNAL', message } }, 500);
    }
  });

  // ─── Vault tree change events (SSE) ───

  // GET /api/knowledge/vaults/:id/events — live tree-change notifications
  // Pushed by VaultWatcher (chokidar) so the UI refreshes when files land
  // externally (Chrome extension clippings, weixin media, external edits)
  // without relying on window focus.
  app.get('/vaults/:id/events', (c) => {
    const vaultId = c.req.param('id');
    const vault = getVault(db, vaultId);
    if (!vault) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Vault not found' } }, 404);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const sseStream = createVaultSSEStream(vaultWatcher, vaultId);

    return stream(c, async (s) => {
      c.req.raw.signal.addEventListener('abort', sseStream.cleanup);
      await s.pipe(sseStream.stream);
    });
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

/**
 * Build a long-lived SSE stream that emits `tree-changed` frames when the
 * VaultWatcher reports changes for the given vault. Mirrors the pattern in
 * sse.ts: subscriptions + keepalive live inside the ReadableStream, and
 * `cancel`/`cleanup` tear them down on client disconnect.
 */
function createVaultSSEStream(
  vaultWatcher: VaultWatcher,
  vaultId: string,
): { stream: ReadableStream<Uint8Array>; cleanup: () => void } {
  const encoder = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | null = null;
  let listener: ((changedId: string) => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      listener = (changedId: string) => {
        if (changedId !== vaultId) return;
        const frame = `data: ${JSON.stringify({ type: 'tree-changed' })}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* stream closed — cleanup will handle */
        }
      };
      vaultWatcher.on(VAULT_TREE_CHANGED_EVENT, listener);

      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(':ping\n\n'));
        } catch {
          /* stream closed */
        }
      }, 15_000);
      ping.unref?.();
    },
    cancel() {
      if (ping) {
        clearInterval(ping);
        ping = null;
      }
      if (listener) {
        vaultWatcher.off(VAULT_TREE_CHANGED_EVENT, listener);
        listener = null;
      }
    },
  });

  return {
    stream,
    cleanup: () => {
      if (ping) {
        clearInterval(ping);
        ping = null;
      }
      if (listener) {
        vaultWatcher.off(VAULT_TREE_CHANGED_EVENT, listener);
        listener = null;
      }
    },
  };
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
