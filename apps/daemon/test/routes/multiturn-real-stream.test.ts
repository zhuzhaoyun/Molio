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
 * Root-cause regression test for issue #87.
 *
 * Real Claude Code stream-json (verified against Claude Code 2.1.168) emits the
 * assistant message block with `stop_reason: null` during streaming — the
 * terminal stop_reason ("end_turn") only arrives on the final `result` event.
 * Therefore `turn_end` is emitted exclusively by the `result` fallback path in
 * claude-stream.ts (the `assistant` branch never fires because stop_reason is
 * not a string).
 *
 * The `turnEndEmitted` guard is set to true when the `result` fallback runs.
 * Across a multi-turn conversation, if that guard is NOT reset on the next
 * turn's `message_start`, the second turn's `result` fallback is suppressed,
 * `turn_end` is never emitted for the second turn, and the RunManager never
 * flushes the second (last) assistant reply to the database. This is exactly
 * what issue #87 reported: the last assistant reply is missing from history.
 *
 * This test fakes that real streaming shape (stop_reason: null on assistant
 * blocks) and asserts both replies are persisted.
 */
describe('Multi-turn persistence with real Claude Code stream shape', () => {
  let db: Database.Database;
  let tempDir: string;
  let runManager: RunManager;
  let conversationService: ConversationService;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-real-stream-test-'));
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
    // Mimic real Claude Code: assistant blocks carry stop_reason: null.
    process.env['FAKE_CLAUDE_REAL_STREAM'] = '1';
    process.env['FAKE_CLAUDE_MULTI_TURN'] = '1';
  });

  afterEach(() => {
    runManager.cancelAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['CLAUDE_BIN'];
    delete process.env['FAKE_CLAUDE_REAL_STREAM'];
    delete process.env['FAKE_CLAUDE_MULTI_TURN'];
  });

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

  it('persists the last assistant reply when assistant blocks lack stop_reason', async () => {
    const createRes = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: 'first question' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json() as { runId: string; conversationId: string };
    const { runId, conversationId } = created;

    // First reply must be flushed via the result fallback (assistant block had
    // stop_reason: null, so no turn_end from the assistant branch).
    await waitForAssistantCount(conversationId, 1);

    // Second turn — the "last reply" that issue #87 reported missing.
    const sendRes = await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'second question' }),
    });
    assert.equal(sendRes.status, 200);

    await waitForAssistantCount(conversationId, 2);

    const messages = listMessages(db, conversationId);
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMessages.length, 2, 'both assistant replies must be persisted, including the last one');
    assert.equal(assistantMessages[0]!.content, 'Reply #1');
    assert.equal(assistantMessages[1]!.content, 'Reply #2');
  });
});
