import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runsRoutes } from '../../src/routes/runs.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { closeDatabase, openDatabase, createVault } from '../../src/core/db.js';

/**
 * Path-traversal regression for POST /api/runs with wikiExtra.filePath.
 *
 * The route reads the referenced file from the vault and embeds its content
 * into the agent prompt. A malicious filePath like "../secret.txt" must NOT
 * escape the vault root — otherwise a localhost-origin caller (CORS allows
 * any http://localhost:* origin, no auth) gets an arbitrary local-file read
 * primitive via the agent's SSE reply. resolveFilePath enforces the vault
 * boundary; traversal attempts fall through to the "not accessible" branch.
 */

/** Minimal RunManager stub that captures the prompt message without spawning. */
class CapturingRunManager {
  lastMessage = '';
  async createRun(opts: { message: string }): Promise<string> {
    this.lastMessage = opts.message;
    return 'run-traversal-mock';
  }
  listRuns() {
    return [];
  }
  getRunInfo() {
    return null;
  }
}

describe('POST /api/runs — wikiExtra.filePath path traversal', () => {
  let db: Database.Database;
  let sandbox: string;
  let vaultDir: string;
  let conversations: ConversationService;
  let runManager: CapturingRunManager;
  let app: Hono;
  let vaultId: string;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'molio-traversal-'));
    // Vault lives inside the sandbox; a sibling file sits outside the vault
    // but inside the sandbox, reachable via "../" from the vault root.
    vaultDir = join(sandbox, 'vault');
    mkdirSync(vaultDir, { recursive: true });

    // In-vault file (legitimate access should still work)
    writeFileSync(join(vaultDir, 'note.md'), 'IN_VAULT_CONTENT');
    // Out-of-vault file (traversal must NOT read this)
    writeFileSync(join(sandbox, 'secret.txt'), 'OUTSIDE_VAULT_SECRET');

    db = openDatabase(join(sandbox, 'data'));
    const vault = createVault(db, 'traversal-vault', vaultDir);
    vaultId = vault.id;
    conversations = new ConversationService(db);
    runManager = new CapturingRunManager();

    const root = new Hono();
    root.route('/api/runs', runsRoutes(db, runManager as any, conversations));
    app = root;
  });

  after(() => {
    closeDatabase();
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function postRun(filePath: string): Promise<{ status: number; message: string }> {
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'claude',
        message: 'tell me about this file',
        cwd: vaultDir,
        wikiExtra: { filePath },
        // no history → triggers the file-injection branch
      }),
    });
    return { status: res.status, message: runManager.lastMessage };
  }

  it('should refuse to read files outside the vault via "../" traversal', async () => {
    const { status, message } = await postRun('../secret.txt');

    assert.equal(status, 201, 'run should still be created');
    assert.ok(
      !message.includes('OUTSIDE_VAULT_SECRET'),
      `traversal must not leak out-of-vault file content into prompt; got: ${message}`,
    );
    // The handler should fall through to the "not accessible" branch.
    assert.ok(
      message.includes('不存在或无法访问'),
      `expected not-accessible fallback in prompt, got: ${message}`,
    );
  });

  it('should still read legitimate files inside the vault', async () => {
    const { status, message } = await postRun('note.md');

    assert.equal(status, 201);
    assert.ok(
      message.includes('IN_VAULT_CONTENT'),
      `legitimate in-vault file content should be embedded in prompt; got: ${message}`,
    );
  });
});
