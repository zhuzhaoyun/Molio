import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { conversationRoutes } from '../../src/routes/conversations.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { closeDatabase, openDatabase, upsertMessage, createDesktopConversation, listMessages } from '../../src/core/db.js';
import type { ChatMessage, RewindResendResponse } from '@molio/contracts';

class MockRunManager {
  readonly calls: Array<{ op: string; agentId?: string; message?: string; history?: ChatMessage[]; cwd?: string }> = [];
  readonly cancelled: string[] = [];
  private terminal = new Set<string>();
  private contexts = new Map<string, { agentId: string; conversationId: string | null }>();
  /** Stored onTurnComplete callbacks for runs registered via registerDeferredRun. */
  private deferredCallbacks = new Map<string, (text: string, rid: string) => void>();

  createRun(opts: { agentId: string; message: string; history?: ChatMessage[]; cwd?: string; onTurnComplete?: (t: string, r: string) => void }): Promise<string> {
    this.calls.push({ op: 'createRun', agentId: opts.agentId, message: opts.message, history: opts.history, cwd: opts.cwd });
    const runId = `run-${this.calls.length}`;
    this.contexts.set(runId, { agentId: opts.agentId, conversationId: null });
    // simulate immediate turn completion → persist assistant reply
    opts.onTurnComplete?.(`reply-${this.calls.length}`, runId);
    return Promise.resolve(runId);
  }
  getRunContext(runId: string) { return this.contexts.get(runId) ?? null; }
  isTerminal(runId: string) { return this.terminal.has(runId); }
  // Mirrors the real RunManager.cancelRun after the Option A fix: cancelRun
  // synchronously marks the run terminal so isTerminal returns true immediately.
  cancelRun(runId: string) { this.cancelled.push(runId); this.terminal.add(runId); }

  /** Register a run whose onTurnComplete is NOT called immediately — mirrors a
   * real run that is still streaming when it gets cancelled. */
  registerDeferredRun(
    runId: string,
    ctx: { agentId: string; conversationId: string | null },
    onTurnComplete: (text: string, rid: string) => void,
  ): void {
    this.contexts.set(runId, ctx);
    this.deferredCallbacks.set(runId, onTurnComplete);
  }

  /** Simulate a late buffered turn_end from a dying run. */
  triggerDeferredTurnEnd(runId: string, text: string): void {
    const cb = this.deferredCallbacks.get(runId);
    if (cb) cb(text, runId);
  }
}

function mkMsg(role: 'user' | 'assistant', content: string, runId?: string): ChatMessage {
  return { id: `${role}-${content}`, role, content, timestamp: Date.now(), runId };
}

describe('POST /api/conversations/:id/rewind-resend', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let conversations: ConversationService;
  let runManager: MockRunManager;
  let app: Hono;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-rr-'));
    db = openDatabase(join(dir, 'app.sqlite'));
    conversations = new ConversationService(db);
    runManager = new MockRunManager();
    app = new Hono();
    app.route('/api/conversations', conversationRoutes(db, runManager as unknown as Parameters<typeof conversationRoutes>[1], conversations));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function postRewind(convId: string, body: { newContent: string; agentId?: string; cwd?: string }) {
    const res = await app.request(`/api/conversations/${convId}/rewind-resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as RewindResendResponse & { error?: { code: string; message: string } } };
  }

  it('truncates from last user message and starts a new run with surviving history', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1', 'run-old'));
    upsertMessage(db, conv.id, mkMsg('user', 'q2'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a2', 'run-old'));

    const { status, body } = await postRewind(conv.id, { newContent: 'q2', agentId: 'claude' });
    assert.equal(status, 200);
    assert.equal(body.runId, 'run-1');
    assert.equal(body.conversationId, conv.id);

    // createRun was called with history = messages before last user msg = [q1, a1]
    const last = runManager.calls.at(-1)!;
    assert.equal(last.history?.length, 2);
    assert.equal(last.history![0]!.content, 'q1');
    assert.equal(last.history![1]!.content, 'a1');
    assert.equal(last.message, 'q2');

    // DB: q2-old + a2-old deleted; new user 'q2' + assistant 'reply-1' appended
    const msgs = listMessages(db, conv.id).map((m) => m.content);
    assert.deepEqual(msgs, ['q1', 'a1', 'q2', 'reply-1']);
  });

  it('cancels the active run if still alive', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1', 'run-alive'));
    // register the alive run in the mock
    (runManager as unknown as { contexts: Map<string, unknown> }).contexts.set('run-alive', { agentId: 'claude', conversationId: conv.id });

    await postRewind(conv.id, { newContent: 'q1', agentId: 'claude' });
    assert.deepEqual(runManager.cancelled, ['run-alive']);
  });

  it('uses edited content as the new user message', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'original'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1', 'run-old'));

    await postRewind(conv.id, { newContent: 'edited question', agentId: 'claude' });
    const last = runManager.calls.at(-1)!;
    assert.equal(last.message, 'edited question');
    const msgs = listMessages(db, conv.id).map((m) => m.content);
    assert.deepEqual(msgs, ['edited question', 'reply-1']);
  });

  it('falls back to last assistant agentId when body.agentId absent', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));
    upsertMessage(db, conv.id, { ...mkMsg('assistant', 'a1', 'run-old'), agentId: 'qwen' });

    await postRewind(conv.id, { newContent: 'q1' });
    const last = runManager.calls.at(-1)!;
    assert.equal(last.agentId, 'qwen');
  });

  it('returns 400 when newContent is empty', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));
    const { status, body } = await postRewind(conv.id, { newContent: '  ' });
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'BAD_REQUEST');
  });

  it('returns 404 when conversation does not exist', async () => {
    const { status } = await postRewind('no-such-conv', { newContent: 'x', agentId: 'claude' });
    assert.equal(status, 404);
  });

  it('does not truncate when no user message exists', async () => {
    const conv = createDesktopConversation(db, 't');
    const { status, body } = await postRewind(conv.id, { newContent: 'x', agentId: 'claude' });
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'BAD_REQUEST');
  });

  it('drops a late onTurnComplete from the cancelled run (no orphan assistant reply)', async () => {
    // Reproduces the cancel-then-truncate race: the rewind-resend endpoint
    // cancels the active run, truncates history, and starts a fresh run. A
    // late turn_end from the dying run must NOT append an orphan assistant
    // reply after the new user message.
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1', 'run-old'));
    upsertMessage(db, conv.id, mkMsg('user', 'q2'));
    // A partial/streaming reply from 'run-alive' — getRewindPoint uses this
    // assistant message's run_id as the activeRunId to cancel.
    upsertMessage(db, conv.id, mkMsg('assistant', 'partial-reply', 'run-alive'));

    // Pre-register the alive run with a DEFERRED onTurnComplete that mirrors
    // run-starter.ts (including the isTerminal defense-in-depth gate).
    runManager.registerDeferredRun(
      'run-alive',
      { agentId: 'claude', conversationId: conv.id },
      (text, rid) => {
        if (runManager.isTerminal(rid)) return;
        conversations.appendMessage(conv.id, {
          id: randomUUID(),
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          agentId: 'claude',
          runId: rid,
        });
      },
    );

    const { status } = await postRewind(conv.id, { newContent: 'q2', agentId: 'claude' });
    assert.equal(status, 200);
    assert.deepEqual(runManager.cancelled, ['run-alive']);

    // Simulate a late buffered turn_end from the dying 'run-alive' process —
    // its onTurnComplete fires AFTER the new run already appended 'reply-1'.
    runManager.triggerDeferredTurnEnd('run-alive', 'orphan-old-assistant');

    // Expected: [q1, a1, q2, reply-1] — NO orphan 'orphan-old-assistant'.
    const msgs = listMessages(db, conv.id).map((m) => m.content);
    assert.deepEqual(msgs, ['q1', 'a1', 'q2', 'reply-1']);
  });
});
