import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runsRoutes } from '../../src/routes/runs.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { closeDatabase, openDatabase, listMessages } from '../../src/core/db.js';
import { TurnTextCollector } from '../../src/core/turn-text-collector.js';

/**
 * Integration test for multi-turn message ordering in the runs route.
 *
 * Regression test for PR #75: when a user sends a follow-up message while
 * the assistant still has unflushed text, the pending assistant reply must
 * be persisted BEFORE the new user message so that DB position ordering
 * matches the actual conversation order.
 *
 * This test uses a real SQLite database and a mock RunManager to verify
 * the exact call sequence in the POST /:id/messages handler.
 */

interface MockRunContext {
  agentId: string;
  conversationId: string | null;
}

class MockRunManager {
  private contexts: Map<string, MockRunContext> = new Map();
  private collectors: Map<string, TurnTextCollector> = new Map();
  /** Records every operation in order so we can assert the sequence. */
  readonly operations: Array<{ op: string; content?: string }> = [];

  registerRun(runId: string, ctx: MockRunContext, collector: TurnTextCollector): void {
    this.contexts.set(runId, ctx);
    this.collectors.set(runId, collector);
  }

  getRunContext(runId: string): MockRunContext | null {
    return this.contexts.get(runId) ?? null;
  }

  flushPendingReply(runId: string): void {
    const collector = this.collectors.get(runId);
    if (collector) {
      // Record the flush as an operation — the callback inside the collector
      // will record the actual assistant message insert.
      this.operations.push({ op: 'flush' });
      collector.flush();
    }
  }

  sendMessage(runId: string, _message: string): void {
    this.operations.push({ op: 'sendMessage' });
  }
}

describe('Multi-turn message ordering', () => {
  let db: Database.Database;
  let tempDir: string;
  let conversations: ConversationService;
  let mockRunManager: MockRunManager;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-msg-order-'));
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
    mockRunManager = new MockRunManager();

    const root = new Hono();
    root.route('/api/runs', runsRoutes(db, mockRunManager as any, conversations));
    app = root;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should persist assistant reply before user message when sending follow-up', async () => {
    // Setup: create a conversation and register a mock run
    const conversation = conversations.createDesktopConversation('test');
    const runId = 'run-order-test';

    // Track what gets persisted and in what order
    const persistedMessages: Array<{ role: string; content: string }> = [];

    // Wrap appendMessage to record insertion order
    const originalAppendMessage = conversations.appendMessage.bind(conversations);
    conversations.appendMessage = (convId: string, msg: any) => {
      persistedMessages.push({ role: msg.role, content: msg.content });
      return originalAppendMessage(convId, msg);
    };

    // Create a TurnTextCollector that simulates accumulated assistant text
    const collector = new TurnTextCollector(runId, (text, _tools, rid) => {
      conversations.appendMessage(conversation.id, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        agentId: 'claude',
        runId: rid,
      });
    });

    // Simulate: assistant has accumulated a partial reply
    collector.append('Assistant reply to first question.');

    // Register the run with our mock
    mockRunManager.registerRun(runId, {
      agentId: 'claude',
      conversationId: conversation.id,
    }, collector);

    // Act: send a follow-up user message via the route
    const res = await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Second user question' }),
    });

    assert.equal(res.status, 200);

    // Assert: assistant reply should be persisted BEFORE user message
    assert.equal(persistedMessages.length, 2, 'Should have 2 messages persisted');
    assert.equal(persistedMessages[0]!.role, 'assistant', 'First persisted message should be assistant reply');
    assert.equal(persistedMessages[0]!.content, 'Assistant reply to first question.');
    assert.equal(persistedMessages[1]!.role, 'user', 'Second persisted message should be user message');
    assert.equal(persistedMessages[1]!.content, 'Second user question');

    // Also verify DB position ordering matches
    const dbMessages = listMessages(db, conversation.id);
    assert.equal(dbMessages.length, 2);
    assert.equal(dbMessages[0]!.role, 'assistant');
    assert.equal(dbMessages[1]!.role, 'user');
  });

  it('should maintain correct ordering across multiple turns', async () => {
    const conversation = conversations.createDesktopConversation('multi-turn test');
    const runId = 'run-multi-turn';

    const persistedMessages: Array<{ role: string; content: string }> = [];
    const originalAppendMessage = conversations.appendMessage.bind(conversations);
    conversations.appendMessage = (convId: string, msg: any) => {
      persistedMessages.push({ role: msg.role, content: msg.content });
      return originalAppendMessage(convId, msg);
    };

    const collector = new TurnTextCollector(runId, (text, _tools, rid) => {
      conversations.appendMessage(conversation.id, {
        id: `assistant-${persistedMessages.length}`,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        agentId: 'claude',
        runId: rid,
      });
    });

    mockRunManager.registerRun(runId, {
      agentId: 'claude',
      conversationId: conversation.id,
    }, collector);

    // Turn 1: simulate initial user message (normally done by POST /api/runs)
    conversations.appendMessage(conversation.id, {
      id: 'user-1',
      role: 'user',
      content: 'First question',
      timestamp: Date.now(),
      agentId: 'claude',
    });

    // Assistant accumulates reply
    collector.append('First answer.');

    // Turn 2: user sends follow-up → flush should happen before user insert
    await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Second question' }),
    });

    // Assistant accumulates second reply
    collector.append('Second answer.');

    // Turn 3: another follow-up
    await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Third question' }),
    });

    // Final flush (simulating turn_end)
    collector.flush();

    // Expected order: user1, assistant1, user2, assistant2, user3, assistant3
    const expectedOrder = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer.' },
      { role: 'user', content: 'Third question' },
      { role: 'assistant', content: 'Third answer.' },  // from final flush — wait, no third answer was accumulated after turn 3
    ];

    // Actually after turn 3, there's no assistant reply accumulated yet,
    // so the final flush should not produce anything. Let's check what we got.
    // After turn 2 sendMessage: flushed "First answer.", inserted "Second question"
    // Then accumulated "Second answer."
    // After turn 3 sendMessage: flushed "Second answer.", inserted "Third question"
    // Final flush: buffer is empty → nothing

    assert.equal(persistedMessages.length, 5, 'Should have 5 messages (no assistant reply after third question)');
    assert.equal(persistedMessages[0]!.role, 'user');
    assert.equal(persistedMessages[0]!.content, 'First question');
    assert.equal(persistedMessages[1]!.role, 'assistant');
    assert.equal(persistedMessages[1]!.content, 'First answer.');
    assert.equal(persistedMessages[2]!.role, 'user');
    assert.equal(persistedMessages[2]!.content, 'Second question');
    assert.equal(persistedMessages[3]!.role, 'assistant');
    assert.equal(persistedMessages[3]!.content, 'Second answer.');
    assert.equal(persistedMessages[4]!.role, 'user');
    assert.equal(persistedMessages[4]!.content, 'Third question');

    // Verify DB ordering matches
    const dbMessages = listMessages(db, conversation.id);
    assert.equal(dbMessages.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(dbMessages[i]!.role, persistedMessages[i]!.role, `Position ${i} role mismatch`);
      assert.equal(dbMessages[i]!.content, persistedMessages[i]!.content, `Position ${i} content mismatch`);
    }
  });

  it('should handle flush with no pending text without affecting order', async () => {
    const conversation = conversations.createDesktopConversation('empty-flush test');
    const runId = 'run-empty-flush';

    const persistedMessages: Array<{ role: string; content: string }> = [];
    const originalAppendMessage = conversations.appendMessage.bind(conversations);
    conversations.appendMessage = (convId: string, msg: any) => {
      persistedMessages.push({ role: msg.role, content: msg.content });
      return originalAppendMessage(convId, msg);
    };

    // Collector with NO accumulated text
    const collector = new TurnTextCollector(runId, (text, _tools, rid) => {
      conversations.appendMessage(conversation.id, {
        id: `assistant-${persistedMessages.length}`,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        agentId: 'claude',
        runId: rid,
      });
    });

    mockRunManager.registerRun(runId, {
      agentId: 'claude',
      conversationId: conversation.id,
    }, collector);

    // Send follow-up when there's nothing to flush
    const res = await app.request(`/api/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Only user message' }),
    });

    assert.equal(res.status, 200);
    assert.equal(persistedMessages.length, 1);
    assert.equal(persistedMessages[0]!.role, 'user');
    assert.equal(persistedMessages[0]!.content, 'Only user message');
  });
});
