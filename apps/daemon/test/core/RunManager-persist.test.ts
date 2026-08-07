import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { RunManager } from '../../src/core/RunManager.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { closeDatabase, openDatabase, listMessages } from '../../src/core/db.js';
import { getAgentDef } from '../../src/core/runtimes/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeClaudePath = join(
  process.cwd(),
  'test/fixtures/fake-agents',
  process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.mjs',
);

describe('RunManager persists assistant reply on successful run', () => {
  let db: Database.Database;
  let tempDir: string;
  let runManager: RunManager;
  let conversations: ConversationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-runmanager-test-'));
    db = openDatabase(tempDir);
    runManager = new RunManager();
    conversations = new ConversationService(db);

    // Point the claude agent at our fake binary
    process.env['CLAUDE_BIN'] = fakeClaudePath;
  });

  afterEach(() => {
    runManager.cancelAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['CLAUDE_BIN'];
  });

  it('should call onTurnComplete and persist the assistant reply', async () => {
    const conv = conversations.createDesktopConversation('Test conversation');
    const agentId = 'claude';

    let turnCompleteCalled = false;
    let turnCompleteText: string | null = null;

    const runId = await runManager.createRun({
      agentId,
      message: 'Say hello',
      conversationId: conv.id,
      onTurnComplete: (text, rid) => {
        turnCompleteCalled = true;
        turnCompleteText = text;
        conversations.appendMessage(conv.id, {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          agentId,
          runId: rid,
        });
      },
    });

    // Wait for the fake agent to exit and finishRun to run
    await new Promise<void>((resolve) => {
      const check = () => {
        const info = runManager.getRunInfo(runId);
        if (info?.status === 'succeeded' || info?.status === 'failed') {
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    assert.ok(turnCompleteCalled, 'onTurnComplete should have been called');
    assert.equal(turnCompleteText, 'Hello from fake Claude!');

    const messages = listMessages(db, conv.id);
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0]!.content, 'Hello from fake Claude!');
  });

  it('should expose conversationId on getRunInfo and listRuns', async () => {
    // KB 会话重挂载恢复依赖 GET /api/runs 里的 conversationId 定位活跃 run ——
    // 没有它，web 端无法在切页返回后恢复进行中的回复。
    const conv = conversations.createDesktopConversation('Test conversation');
    const runId = await runManager.createRun({
      agentId: 'claude',
      message: 'Say hello',
      conversationId: conv.id,
    });

    // 等 run 结束，保证快照稳定
    await new Promise<void>((resolve) => {
      const check = () => {
        const info = runManager.getRunInfo(runId);
        if (info?.status === 'succeeded' || info?.status === 'failed') resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    const info = runManager.getRunInfo(runId);
    assert.ok(info, 'getRunInfo should return a run');
    assert.equal(info.conversationId, conv.id);

    const runs = runManager.listRuns();
    const found = runs.find((r) => r.id === runId);
    assert.ok(found, 'run should appear in listRuns');
    assert.equal(found.conversationId, conv.id);
  });
});
