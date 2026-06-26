import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentEvent, ChatMessage } from '@molio/contracts';
import { openDatabase, closeDatabase, listMessages } from '../../../src/core/db.js';
import { WeixinService } from '../../../src/core/weixin/service.js';
import { ConversationService } from '../../../src/core/conversations/service.js';
import type { RunManager } from '../../../src/core/RunManager.js';
import type { QueuedMessage } from '../../../src/core/weixin/service.js';

/**
 * Integration tests for WeChat multi-turn run reuse.
 *
 * Regression coverage for the fix where each WeChat message used to spawn a
 * fresh `claude -p` process, throwing away Claude Code's native session
 * continuity (and prompt cache). The channel now reuses one multi-turn run
 * per user via RunManager.sendMessage(), queuing messages while a turn is in
 * flight and draining on turn_end.
 *
 * These tests drive the dispatch state machine (dispatchMessage →
 * forwardRunReply → drainQueue) directly with a mock RunManager whose event
 * listeners the test can fire, plus a real SQLite conversation store so DB
 * ordering is verified. createMolioRun's config resolution is deliberately
 * bypassed to keep the state-machine assertions hermetic.
 */

interface DispatchPayload extends QueuedMessage {
  history: ChatMessage[];
}

class MockRunManager {
  private nextId = 1;
  private created = new Set<string>();
  private nonReceptive = new Set<string>();
  private listeners = new Map<string, (ev: AgentEvent) => void>();
  readonly createRunCalls: Array<{ runId: string; agentId: string; cwd?: string }> = [];
  readonly sendMessageCalls: Array<{ runId: string; message: string }> = [];
  readonly flushCalls: string[] = [];
  readonly cancelCalls: string[] = [];

  createRun = async (opts: {
    agentId: string;
    message: string;
    cwd?: string;
    conversationId?: string;
    history?: ChatMessage[];
  }): Promise<string> => {
    const runId = `run-${this.nextId++}`;
    this.created.add(runId);
    this.createRunCalls.push({ runId, agentId: opts.agentId, cwd: opts.cwd });
    return runId;
  };

  canAcceptMessage = (runId: string): boolean => {
    return this.created.has(runId) && !this.nonReceptive.has(runId);
  };

  /** Test helper: mark a run as no longer reusable (e.g. process exited). */
  markNonReceptive(runId: string): void {
    this.nonReceptive.add(runId);
  }

  sendMessage = (runId: string, message: string): void => {
    this.sendMessageCalls.push({ runId, message });
  };

  flushPendingReply = (runId: string): void => {
    this.flushCalls.push(runId);
  };

  cancelRun = (runId: string): void => {
    this.cancelCalls.push(runId);
    this.nonReceptive.add(runId);
  };

  cancelAll = (): void => {};

  onEvent = (runId: string, cb: (ev: AgentEvent) => void): (() => void) | null => {
    if (!this.created.has(runId)) return null;
    this.listeners.set(runId, cb);
    return () => { this.listeners.delete(runId); };
  };

  /** Test helper: emit an event to the run's current listener. */
  emit(runId: string, ev: AgentEvent): void {
    const cb = this.listeners.get(runId);
    if (cb) cb(ev);
  }

  asRunManager(): RunManager {
    return this as unknown as RunManager;
  }
}

/** Let fire-and-forget async paths (finish → drainQueue → dispatch) settle. */
function settle(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('WeixinService multi-turn run reuse', () => {
  let db: Database.Database;
  let tempDir: string;
  let cwdDir: string;
  let conversations: ConversationService;
  let mock: MockRunManager;
  let service: WeixinService;
  let conversationId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-mt-'));
    cwdDir = join(tempDir, 'work');
    mkdirSync(cwdDir, { recursive: true });
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
    mock = new MockRunManager();
    service = new WeixinService(mock.asRunManager(), conversations, db);
    const conv = conversations.getOrCreateExternalConversation({
      channelType: 'weixin',
      externalSessionId: 'u1',
      title: '微信 u1',
    });
    conversationId = conv.id;
  });

  afterEach(() => {
    service.stop();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function payload(text: string, history: ChatMessage[] = []): DispatchPayload {
    return {
      fromUserId: 'u1',
      conversationId,
      agentId: 'claude',
      cwd: cwdDir,
      runMessage: text,
      rawUserText: text,
      history,
    };
  }

  /** Drive the private dispatchMessage directly. */
  function dispatch(p: DispatchPayload): Promise<void> {
    return (service as unknown as {
      dispatchMessage: (p: DispatchPayload) => Promise<void>;
    }).dispatchMessage(p);
  }

  it('reuses the active run for a second message (sendMessage, no new spawn)', async () => {
    await dispatch(payload('first question'));
    const run1 = mock.createRunCalls[0]!.runId;
    assert.equal(mock.createRunCalls.length, 1);
    assert.equal(mock.sendMessageCalls.length, 0);

    // Turn 1 completes before the user sends the next message.
    mock.emit(run1, { type: 'text_delta', delta: 'first answer' });
    mock.emit(run1, { type: 'turn_end', stopReason: 'end_turn' });
    await settle(); // let finish() settle (run stays alive, queue empty)

    await dispatch(payload('second question'));

    assert.equal(mock.createRunCalls.length, 1, 'should NOT spawn a new run');
    assert.equal(mock.sendMessageCalls.length, 1, 'should reuse via sendMessage');
    assert.equal(mock.sendMessageCalls[0]!.runId, run1);
  });

  it('spawns a fresh run and cancels the stale one when the run is not receptive', async () => {
    await dispatch(payload('first'));
    const run1 = mock.createRunCalls[0]!.runId;
    mock.emit(run1, { type: 'turn_end', stopReason: 'end_turn' });
    await settle();

    // Simulate the claude process having exited between turns.
    mock.markNonReceptive(run1);

    await dispatch(payload('second'));

    assert.equal(mock.createRunCalls.length, 2, 'should spawn a fresh run');
    const run2 = mock.createRunCalls[1]!.runId;
    assert.notEqual(run2, run1);
    assert.ok(mock.cancelCalls.includes(run1), 'should cancel the stale run');
    assert.equal(mock.sendMessageCalls.length, 0, 'stale run is not sent a message');
  });

  it('queues a message while a turn is in flight, then drains on turn_end', async () => {
    await dispatch(payload('first'));
    const run1 = mock.createRunCalls[0]!.runId;
    // Turn 1 NOT yet ended → run is busy.

    // Second message arrives mid-turn → must be queued, not sent.
    await dispatch(payload('second'));
    assert.equal(mock.sendMessageCalls.length, 0, 'should queue while busy');

    // Turn 1 ends → finish → drain → queued message is sent into the same run.
    mock.emit(run1, { type: 'text_delta', delta: 'first answer' });
    mock.emit(run1, { type: 'turn_end', stopReason: 'end_turn' });
    await settle(); // let drainQueue → dispatchMessage run

    assert.equal(mock.sendMessageCalls.length, 1, 'queued message drained on turn_end');
    assert.equal(mock.sendMessageCalls[0]!.runId, run1);
    assert.equal(mock.createRunCalls.length, 1, 'still a single run');
  });

  it('persists messages in correct order when a message is queued mid-turn', async () => {
    await dispatch(payload('first'));
    const run1 = mock.createRunCalls[0]!.runId;

    // Second message arrives before turn 1 replies → queued (not yet persisted).
    await dispatch(payload('second'));

    mock.emit(run1, { type: 'text_delta', delta: 'first answer' });
    mock.emit(run1, { type: 'turn_end', stopReason: 'end_turn' });
    await settle();

    const msgs = listMessages(db, conversationId);
    // Expected: user1 → assistant1 → user2 (NOT user1 → user2 → assistant1).
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0]!.role, 'user');
    assert.equal(msgs[0]!.content, 'first');
    assert.equal(msgs[1]!.role, 'assistant');
    assert.equal(msgs[1]!.content, 'first answer');
    assert.equal(msgs[2]!.role, 'user');
    assert.equal(msgs[2]!.content, 'second');
  });

  it('flushes pending assistant reply before persisting the next user message', async () => {
    await dispatch(payload('first'));
    const run1 = mock.createRunCalls[0]!.runId;
    // Assistant text accumulated but not yet flushed (turn not ended).
    mock.emit(run1, { type: 'text_delta', delta: 'first answer' });

    // Turn 1 ends → finish flushes assistant1, then a follow-up is dispatched.
    mock.emit(run1, { type: 'turn_end', stopReason: 'end_turn' });
    await settle();

    // Now dispatch a follow-up into the reused run.
    await dispatch(payload('second'));

    // flushPendingReply was called for run1 before the second user message.
    assert.ok(mock.flushCalls.includes(run1), 'should flush pending reply before next user msg');
  });

  it('/new cancels the reusable run so the next message spawns fresh', async () => {
    await dispatch(payload('first'));
    const run1 = mock.createRunCalls[0]!.runId;

    // Send /new via the raw message handler path (parses text → /new branch).
    const handleRaw = (service as unknown as {
      handleRawMessage: (raw: Record<string, unknown>) => Promise<void>;
    }).handleRawMessage.bind(service);
    await handleRaw({
      message_id: 'new-1',
      from_user_id: 'u1',
      item_list: [{ type: 1, text_item: { text: '/new' } }],
    });

    assert.ok(mock.cancelCalls.includes(run1), '/new should cancel the reusable run');

    // Next message spawns a fresh run (no reuse).
    await dispatch(payload('after new'));
    assert.equal(mock.createRunCalls.length, 2, 'next message after /new spawns fresh');
    assert.equal(mock.sendMessageCalls.length, 0);
  });
});
