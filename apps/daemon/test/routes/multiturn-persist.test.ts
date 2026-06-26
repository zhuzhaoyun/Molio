import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase, listMessages } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { runsRoutes } from '../../src/routes/runs.js';
import { eventsRoutes } from '../../src/routes/events.js';

/**
 * Multi-turn persistence regression test for issue #87.
 *
 * Scenario: a user holds a multi-turn conversation against a multi-turn agent
 * (Claude Code keeps stdin open between turns). Each assistant reply must be
 * persisted to the database, INCLUDING the last one (after which the user sends
 * no further message — only turn_end/usage events can trigger the flush).
 */
describe('Multi-turn assistant reply persistence', () => {
  let db: Database.Database;
  let tempDir: string;
  let runManager: RunManager;
  let conversationService: ConversationService;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-multiturn-test-'));
    db = openDatabase(tempDir);
    runManager = new RunManager();
    conversationService = new ConversationService(db);

    app = new Hono();
    app.route('/api/runs', runsRoutes(db, runManager, conversationService));
    app.route('/api/runs', eventsRoutes(runManager));

    process.env['CLAUDE_BIN'] = join(
      process.cwd(),
      'test/fixtures/fake-agents',
      process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.mjs',
    );
    process.env['FAKE_CLAUDE_MULTI_TURN'] = '1';
  });

  afterEach(() => {
    runManager.cancelAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['CLAUDE_BIN'];
    delete process.env['FAKE_CLAUDE_MULTI_TURN'];
  });

  /** Wait until N assistant messages exist for the conversation. */
  function waitForAssistantCount(conversationId: string, n: number, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const msgs = listMessages(db, conversationId);
        const count = msgs.filter((m) => m.role === 'assistant').length;
        if (count >= n) { resolve(); return; }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Expected ${n} assistant messages, got ${count} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  it('persists every assistant reply across a multi-turn conversation', async () => {
    // Turn 1: createRun (daemon registers onTurnComplete that persists replies)
    const createRes = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: 'first question' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json() as { runId: string; conversationId: string };
    const runId = created.runId;
    const conversationId = created.conversationId;

    // Wait for the first assistant reply to be persisted
    await waitForAssistantCount(conversationId, 1);

    // Turn 2: send a follow-up message on the same run (multi-turn)
    const sendRes = await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'second question' }),
    });
    assert.equal(sendRes.status, 200);

    // Wait for the second assistant reply to be persisted — this is the
    // "last reply" that issue #87 reported as missing.
    await waitForAssistantCount(conversationId, 2);

    const messages = listMessages(db, conversationId);
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMessages.length, 2, 'both assistant replies should be persisted');
    assert.equal(assistantMessages[0]!.content, 'Reply #1');
    assert.equal(assistantMessages[1]!.content, 'Reply #2');
  });
});
