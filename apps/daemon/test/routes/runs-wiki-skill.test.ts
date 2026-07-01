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
import { QUERY_SYS_PROMPT_FILE } from '../../src/core/wiki-prompts.js';
import type { CreateRunOptions, RunManager } from '../../src/core/RunManager.js';

/**
 * After extracting wiki operations to skills, POST /api/runs no longer has a
 * wikiOperation branch — every vault-cwd run attaches the QUERY system-prompt
 * file and the agent invokes wiki-* skills on demand. These tests pin that
 * behavior with a mock RunManager that records createRun opts (no real spawn).
 */
describe('POST /api/runs — wiki-skill routing', () => {
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

  it('attaches the QUERY system-prompt file for a vault cwd and leaves the message clean', async () => {
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: '入库', cwd: vaultPath }),
    });
    assert.equal(res.status, 201);
    assert.equal(createRunCalls.length, 1);
    assert.equal(createRunCalls[0]!.appendSystemPromptFile, QUERY_SYS_PROMPT_FILE);
    assert.equal(createRunCalls[0]!.message, '入库', 'message must not be prepended with a task prompt');
  });

  it('does not attach a system-prompt file when cwd is not a vault', async () => {
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: 'hi', cwd: join(tempDir, 'not-a-vault') }),
    });
    assert.equal(res.status, 201);
    assert.equal(createRunCalls[0]!.appendSystemPromptFile, undefined);
  });

  it('ignores a legacy wikiOperation field — no prompt prepend, still QUERY frame', async () => {
    // The field is gone from CreateRunRequest, but a stale client might still
    // send it. The route must not mangle the message and must route via skills.
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: '构建 wiki', cwd: vaultPath, wikiOperation: 'build' }),
    });
    assert.equal(res.status, 201);
    assert.equal(createRunCalls[0]!.message, '构建 wiki', 'legacy wikiOperation must not trigger prompt prepend');
    assert.equal(createRunCalls[0]!.appendSystemPromptFile, QUERY_SYS_PROMPT_FILE);
  });
});
