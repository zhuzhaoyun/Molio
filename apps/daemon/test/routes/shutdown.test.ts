import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase, listMessages } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { WeixinService } from '../../src/core/weixin/service.js';
import { runsRoutes } from '../../src/routes/runs.js';
import { eventsRoutes } from '../../src/routes/events.js';

const __filename = fileURLToPath(import.meta.url);

describe('Shutdown route', () => {
  let db: Database.Database;
  let tempDir: string;
  let runManager: RunManager;
  let conversationService: ConversationService;
  let app: Hono;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-shutdown-test-'));
    db = openDatabase(tempDir);
    runManager = new RunManager();
    conversationService = new ConversationService(db);

    const weixinService = new WeixinService(runManager, conversationService, db);

    app = new Hono();
    app.route('/api/runs', runsRoutes(db, runManager, conversationService));
    app.route('/api/runs', eventsRoutes(runManager));

    // Recreate the shutdown endpoint from server.ts (omit closeDatabase here so
    // the test can still read the database after shutdown).
    app.post('/api/shutdown', (c) => {
      weixinService.stop();
      runManager.cancelAll();
      // Give the HTTP response a chance to be sent before exiting
      setTimeout(() => process.exit(0), 100);
      return c.body(null, 204);
    });

    originalExit = process.exit;
    (process as any).exit = () => {
      // swallow exit during tests
    };
  });

  afterEach(() => {
    (process as any).exit = originalExit;
    runManager.cancelAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should flush in-flight assistant replies before exiting', async () => {
    // Point the claude agent at our fake binary. Prevent the fake agent from
    // emitting turn_end so the assistant text stays buffered until shutdown.
    const fakeClaudePath = join(
      process.cwd(),
      'test/fixtures/fake-agents',
      process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.mjs',
    );
    process.env['CLAUDE_BIN'] = fakeClaudePath;
    process.env['FAKE_CLAUDE_NO_TURN_END'] = '1';

    const conversation = conversationService.createDesktopConversation('shutdown test');

    await runManager.createRun({
      agentId: 'claude',
      message: 'Say hello',
      conversationId: conversation.id,
      onTurnComplete: (text, rid) => {
        conversationService.appendMessage(conversation.id, {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          agentId: 'claude',
          runId: rid,
        });
      },
    });

    // Wait briefly so the fake agent emits text and is still alive
    await new Promise((resolve) => setTimeout(resolve, 200));

    // At this point the fake agent has emitted text_deltas and is waiting for
    // more stdin. The turn text is buffered and not yet flushed.
    const messagesBeforeShutdown = listMessages(db, conversation.id);
    assert.equal(messagesBeforeShutdown.filter((m) => m.role === 'assistant').length, 0);

    // Shutdown should flush the buffered reply and persist it
    const res = await app.request('/api/shutdown', { method: 'POST' });
    assert.equal(res.status, 204);

    // Wait for the async flush inside cancelAll to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    const messagesAfterShutdown = listMessages(db, conversation.id);
    const assistantMessages = messagesAfterShutdown.filter((m) => m.role === 'assistant');
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0]!.content, 'Hello from fake Claude!');

    delete process.env['CLAUDE_BIN'];
    delete process.env['FAKE_CLAUDE_NO_TURN_END'];
  });
});
