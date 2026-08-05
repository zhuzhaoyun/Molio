import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentEvent, ChatMessage } from '@molio/contracts';
import { openDatabase, closeDatabase, listMessages, createVault } from '../../../src/core/db.js';
import { ConversationService } from '../../../src/core/conversations/service.js';
import type { RunManager } from '../../../src/core/RunManager.js';
import { WeixinRunDispatcher, type DispatchRequest } from '../../../src/core/weixin/dispatcher.js';
import { buildWeixinFrameMessage } from '../../../src/core/weixin/message.js';

/**
 * Integration tests for the weixin multi-turn run dispatcher.
 *
 * Regression coverage for the fix where each weixin message used to spawn a
 * fresh `claude -p` process, throwing away Claude Code's native session
 * continuity (and prompt cache). The dispatcher reuses one multi-turn run per
 * user via RunManager.sendMessage(), queuing messages while a turn is in
 * flight and draining on turn_end.
 *
 * These tests drive WeixinRunDispatcher directly with a mock RunManager whose
 * event listeners the test can fire, plus a real SQLite conversation store so
 * DB ordering is verified. Sinks (sendText/sendMediaFile) are no-op recorders.
 */

class MockRunManager {
  private nextId = 1;
  private created = new Set<string>();
  private nonReceptive = new Set<string>();
  private listeners = new Map<string, (ev: AgentEvent) => void>();
  readonly createRunCalls: Array<{ runId: string; agentId: string; cwd?: string; message: string }> = [];
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
    this.createRunCalls.push({
      runId,
      agentId: opts.agentId,
      cwd: opts.cwd,
      message: opts.message,
    });
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

describe('WeixinRunDispatcher multi-turn run reuse', () => {
  let db: Database.Database;
  let tempDir: string;
  let cwdDir: string;
  let conversations: ConversationService;
  let mock: MockRunManager;
  let dispatcher: WeixinRunDispatcher;
  let conversationId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-mt-'));
    cwdDir = join(tempDir, 'work');
    mkdirSync(cwdDir, { recursive: true });
    db = openDatabase(tempDir);
    // Register cwdDir as a vault (realistic setup). The weixin channel frame is
    // prepended to the first message on every fresh spawn regardless of vault.
    createVault(db, 'Test Vault', cwdDir);
    conversations = new ConversationService(db);
    mock = new MockRunManager();
    dispatcher = new WeixinRunDispatcher({
      runManager: mock.asRunManager(),
      conversations,
      db,
      sink: { sendText: async () => {}, sendMediaFile: async () => {} },
      buildPrompt: (text) => text,
      frameFirstTurn: buildWeixinFrameMessage,
      channelLabel: 'weixin',
    });
    const conv = conversations.getOrCreateExternalConversation({
      channelType: 'weixin',
      externalSessionId: 'u1',
      title: '微信 u1',
    });
    conversationId = conv.id;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function payload(text: string, history: ChatMessage[] = []): DispatchRequest {
    return {
      userId: 'u1',
      conversationId,
      agentId: 'claude',
      cwd: cwdDir,
      rawUserText: text,
      history,
    };
  }

  function dispatch(p: DispatchRequest): Promise<void> {
    return dispatcher.dispatch(p);
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
    await settle(); // let drainQueue → dispatch run

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

  it('prepends the weixin channel frame on fresh spawn, not on reuse sendMessage', async () => {
    // Fresh spawn: the dispatcher wraps the message with the channel frame
    // (收件/入库/问答/文件回传 mechanics + wiki-query routing). The frame replaced
    // the old --append-system-prompt-file injection that the CLI silently
    // dropped — a message prepend always reaches the model.
    await dispatch(payload('介绍一下韩立'));
    assert.equal(mock.createRunCalls.length, 1);
    assert.ok(
      mock.createRunCalls[0]!.message.includes('微信入口助手'),
      'fresh-spawn message must carry the weixin channel frame',
    );
    assert.ok(
      mock.createRunCalls[0]!.message.includes('介绍一下韩立'),
      'fresh-spawn message must still contain the user text',
    );

    const run1 = mock.createRunCalls[0]!.runId;
    mock.emit(run1, { type: 'turn_end', stopReason: 'end_turn' });
    await settle();

    // Reuse: sendMessage gets the clean message only. The frame is intentionally
    // NOT re-prepended — the live process already carries it from its first turn.
    await dispatch(payload('再问一个'));
    assert.equal(mock.createRunCalls.length, 1, 'reuse must not spawn a new run');
    assert.equal(mock.sendMessageCalls.length, 1);
    assert.equal(mock.sendMessageCalls[0]!.message, '再问一个', 'reuse message must be clean (no frame)');
    assert.ok(
      !mock.sendMessageCalls[0]!.message.includes('微信入口助手'),
      'reuse message must not re-carry the frame',
    );
  });

  it('re-frames the message when a queued message drains into a fresh spawn', async () => {
    // Regression analog: a queued follow-up that drains into a fresh spawn (run
    // died / timed out) must get the channel frame re-prepended — the new
    // process does NOT carry the frame from the dead one.
    await dispatch(payload('first'));
    const run1 = mock.createRunCalls[0]!.runId;

    // Second message arrives mid-turn → queued.
    await dispatch(payload('second'));
    assert.equal(mock.sendMessageCalls.length, 0, 'should queue while busy');

    // Run dies mid-conversation, then turn_end drains the queue.
    mock.markNonReceptive(run1);
    mock.emit(run1, { type: 'turn_end', stopReason: 'end_turn' });
    await settle(); // let drainQueue → fresh-spawn dispatch run

    assert.equal(mock.createRunCalls.length, 2, 'queued msg drained into a fresh spawn');
    assert.ok(
      mock.createRunCalls[1]!.message.includes('微信入口助手'),
      'fresh spawn from a drained queue must re-carry the channel frame',
    );
    assert.ok(mock.createRunCalls[1]!.message.includes('second'));
    assert.equal(mock.sendMessageCalls.length, 0, 'dead run is not sent a message');
  });

  it('cancelUser (the /new action) drops the reusable run so the next message spawns fresh', async () => {
    await dispatch(payload('first'));
    const run1 = mock.createRunCalls[0]!.runId;

    dispatcher.cancelUser('u1');
    assert.ok(mock.cancelCalls.includes(run1), 'cancelUser should cancel the reusable run');

    // Next message spawns a fresh run (no reuse).
    await dispatch(payload('after new'));
    assert.equal(mock.createRunCalls.length, 2, 'next message after cancel spawns fresh');
    assert.equal(mock.sendMessageCalls.length, 0);
  });
});
