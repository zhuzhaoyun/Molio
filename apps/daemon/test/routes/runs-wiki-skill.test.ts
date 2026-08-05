import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { runsRoutes } from '../../src/routes/runs.js';
import type { CreateRunOptions, RunManager } from '../../src/core/RunManager.js';

/**
 * Wiki retrieval is no longer injected per-run via a system-prompt file (the
 * old `--append-system-prompt-file` QUERY frame was silently dropped by the
 * CLI). It now lives in the on-demand `wiki-query` skill, triggered by the
 * vault's .claude/CLAUDE.md rule + the KB qa panel. So POST /api/runs must pass
 * the user message through CLEAN (no task-prompt prepend) and forward cwd — the
 * agent picks up wiki behavior from the installed skill + CLAUDE.md, not from
 * the run request. These tests pin that with a mock RunManager (no real spawn).
 */
describe('POST /api/runs — wiki retrieval is skill-based, not injected', () => {
  let db: Database.Database;
  let tempDir: string;
  let vaultPath: string;
  let app: Hono;
  let createRunCalls: CreateRunOptions[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-runs-wiki-'));
    vaultPath = join(tempDir, 'vault');
    db = openDatabase(tempDir);
    createVault(db, 'Test Vault', vaultPath);
    const conversations = new ConversationService(db);
    createRunCalls = [];
    const mockRunManager = {
      createRun: async (opts: CreateRunOptions) => {
        createRunCalls.push(opts);
        return 'run-1';
      },
    } as unknown as RunManager;
    app = new Hono();
    app.route('/api/runs', runsRoutes(db, mockRunManager, conversations));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes the message through clean for a vault cwd and forwards cwd', async () => {
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: '介绍一下韩立', cwd: vaultPath }),
    });
    assert.equal(res.status, 201);
    assert.equal(createRunCalls.length, 1);
    assert.equal(createRunCalls[0]!.message, '介绍一下韩立', 'message must not be prepended with a task prompt');
    assert.equal(createRunCalls[0]!.cwd, vaultPath, 'cwd must be forwarded so the agent loads the vault skills + CLAUDE.md');
  });

  it('creates a run the same way when cwd is not a vault', async () => {
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: 'hi', cwd: join(tempDir, 'not-a-vault') }),
    });
    assert.equal(res.status, 201);
    assert.equal(createRunCalls[0]!.message, 'hi');
  });

  it('ignores a legacy wikiOperation field — message is never mangled', async () => {
    // The field is gone from CreateRunRequest, but a stale client might still
    // send it. The route must not mangle the message.
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: '构建 wiki', cwd: vaultPath, wikiOperation: 'build' }),
    });
    assert.equal(res.status, 201);
    assert.equal(createRunCalls[0]!.message, '构建 wiki', 'legacy wikiOperation must not trigger prompt prepend');
  });
});
