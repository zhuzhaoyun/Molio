import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentEvent, ChatMessage } from '@molio/contracts';
import { openDatabase, closeDatabase, listMessages } from '../../../src/core/db.js';
import { ConversationService } from '../../../src/core/conversations/service.js';
import type { RunManager } from '../../../src/core/RunManager.js';
import { ChannelDispatcher } from '../../../src/core/channels/dispatcher.js';
import type { ChannelSink, OutboundMediaItem } from '../../../src/core/channels/types.js';

/**
 * Attachment-delivery failure visibility for the shared channel dispatcher.
 *
 * Regression coverage for the 2026-08-23 feishu incident: the user asked for
 * two meeting records, the agent replied "已附上《…原文.md》和《….md》", but no
 * files arrived — and nothing was logged. All three failure paths were
 * silent:
 *   1. `<attach/>` marker path didn't resolve → marker stripped silently;
 *   2. sink sendMediaFile threw (upload/send failure) → caught + console only;
 *   3. a failure on one attachment aborted the rest of the delivery loop.
 *
 * Now: failures are collected per-item (one bad attachment doesn't block the
 * others) and the user receives an explicit "未能发送" notice naming each file.
 */

class MockRunManager {
  private nextId = 1;
  private created = new Set<string>();
  private listeners = new Map<string, (ev: AgentEvent) => void>();
  readonly createRunCalls: Array<{ runId: string; message: string }> = [];

  createRun = async (opts: {
    agentId: string;
    message: string;
    cwd?: string;
    conversationId?: string;
    history?: ChatMessage[];
  }): Promise<string> => {
    const runId = `run-${this.nextId++}`;
    this.created.add(runId);
    this.createRunCalls.push({ runId, message: opts.message });
    return runId;
  };

  canAcceptMessage = (runId: string): boolean => this.created.has(runId);
  sendMessage = (_runId: string, _message: string): void => {};
  flushPendingReply = (_runId: string): void => {};
  cancelRun = (_runId: string): void => {};

  onEvent = (runId: string, cb: (ev: AgentEvent) => void): (() => void) | null => {
    if (!this.created.has(runId)) return null;
    this.listeners.set(runId, cb);
    return () => { this.listeners.delete(runId); };
  };

  emit(runId: string, ev: AgentEvent): void {
    const cb = this.listeners.get(runId);
    if (cb) cb(ev);
  }

  asRunManager(): RunManager {
    return this as unknown as RunManager;
  }
}

/** Sink that records sends; can be told which file paths should fail. */
class RecordingSink {
  readonly texts: string[] = [];
  readonly media: OutboundMediaItem[] = [];
  readonly failMediaPaths = new Set<string>();

  sendText = async (_to: string, text: string): Promise<void> => {
    this.texts.push(text);
  };

  sendMediaFile = async (_to: string, item: OutboundMediaItem): Promise<void> => {
    if (this.failMediaPaths.has(item.filePath)) throw new Error('upload exploded');
    this.media.push(item);
  };

  asSink(): ChannelSink {
    return this as unknown as ChannelSink;
  }
}

/** Let fire-and-forget async paths (finish → sendText/sendMediaFile) settle. */
function settle(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ChannelDispatcher — attachment delivery failure visibility', () => {
  let db: Database.Database;
  let tempDir: string;
  let cwdDir: string;
  let conversations: ConversationService;
  let mock: MockRunManager;
  let sink: RecordingSink;
  let dispatcher: ChannelDispatcher;
  let conversationId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-dispatch-attach-'));
    cwdDir = join(tempDir, 'vault');
    mkdirSync(cwdDir, { recursive: true });
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
    mock = new MockRunManager();
    sink = new RecordingSink();
    dispatcher = new ChannelDispatcher({
      runManager: mock.asRunManager(),
      conversations,
      db,
      sink: sink.asSink(),
      channelLabel: 'test-channel',
    });
    const conv = conversations.getOrCreateExternalConversation({
      channelType: 'feishu',
      externalSessionId: 'u1',
      title: '测试渠道 u1',
    });
    conversationId = conv.id;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function dispatchAndReply(replyText: string): Promise<string> {
    await dispatcher.dispatch({
      userId: 'u1',
      conversationId,
      agentId: 'claude',
      cwd: cwdDir,
      rawUserText: '把文件发给我',
      history: [],
    });
    const runId = mock.createRunCalls[0]!.runId;
    mock.emit(runId, { type: 'text_delta', delta: replyText });
    mock.emit(runId, { type: 'turn_end', stopReason: 'end_turn' });
    await settle();
    return runId;
  }

  it('unresolved marker → user is TOLD the attachment was not delivered', async () => {
    // The 2026-08-23 incident shape: reply says "已附上", marker path points
    // at a file that doesn't exist. Before the fix the marker was stripped
    // silently and the user waited forever.
    await dispatchAndReply('已附上。<attach path="reports/纪要.md"/>');

    assert.equal(sink.media.length, 0, 'nothing deliverable');
    const notice = sink.texts.find((t) => t.includes('未能发送'));
    assert.ok(notice, 'user must receive an explicit failure notice');
    assert.ok(notice!.includes('纪要.md'), 'notice names the file');
    assert.ok(notice!.includes('找不到该文件'), 'notice explains why');
    // The clean reply text still goes out, and never contains the raw path.
    assert.ok(sink.texts.some((t) => t.includes('已附上')), 'reply text still sent');
    assert.ok(
      sink.texts.every((t) => !t.includes('reports/纪要.md')),
      'no local path reaches the IM channel',
    );
    // The failure is also persisted so desktop history matches reality.
    const msgs = listMessages(db, conversationId);
    assert.ok(
      msgs.some((m) => m.role === 'assistant' && m.content.includes('未能发送')),
      'failure notice persisted in conversation history',
    );
  });

  it('one failing upload does not block the rest, and the user is told which failed', async () => {
    mkdirSync(join(cwdDir, 'reports'), { recursive: true });
    const a = join(cwdDir, 'reports', 'a.md');
    const b = join(cwdDir, 'reports', 'b.md');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    sink.failMediaPaths.add(a);

    await dispatchAndReply(
      `两份都发你：<attach path="reports/a.md"/><attach path="reports/b.md"/>`,
    );

    assert.equal(sink.media.length, 1, 'the healthy attachment is still delivered');
    assert.equal(sink.media[0]!.fileName, 'b.md');
    const notice = sink.texts.find((t) => t.includes('未能发送'));
    assert.ok(notice, 'user is told about the failed one');
    assert.ok(notice!.includes('a.md'), 'notice names the failed file');
    assert.ok(notice!.includes('发送失败'), 'notice says it was a send failure');
    assert.ok(!notice!.includes('b.md'), 'the delivered file is not listed as failed');
  });

  it('all attachments delivered → no warning notice', async () => {
    mkdirSync(join(cwdDir, 'reports'), { recursive: true });
    writeFileSync(join(cwdDir, 'reports', '纪要.md'), '# 纪要');

    await dispatchAndReply('已附上。<attach path="reports/纪要.md"/>');

    assert.equal(sink.media.length, 1);
    assert.equal(sink.media[0]!.fileName, '纪要.md');
    assert.ok(
      sink.texts.every((t) => !t.includes('未能发送')),
      'no failure notice when delivery succeeded',
    );
  });

  it('marker-only reply → no local path leaks into persisted history', async () => {
    // Before the fix, `cleanText || text` persisted the RAW markers (with
    // local paths) when the reply contained nothing but markers.
    mkdirSync(join(cwdDir, 'reports'), { recursive: true });
    writeFileSync(join(cwdDir, 'reports', '纪要.md'), '# 纪要');

    await dispatchAndReply('<attach path="reports/纪要.md"/>');

    assert.equal(sink.media.length, 1, 'file still delivered');
    const msgs = listMessages(db, conversationId);
    for (const m of msgs) {
      assert.ok(
        !m.content.includes('reports/纪要.md') && !m.content.includes('<attach'),
        `persisted message must not leak marker/path: ${m.content}`,
      );
    }
  });
});
