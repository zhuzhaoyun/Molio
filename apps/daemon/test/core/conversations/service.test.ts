import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { ConversationService } from '../../../src/core/conversations/service.js';
import { closeDatabase, openDatabase } from '../../../src/core/db.js';

describe('ConversationService', () => {
  let db: Database.Database;
  let tempDir: string;
  let service: ConversationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-conv-test-'));
    db = openDatabase(tempDir);
    service = new ConversationService(db);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reuses the same conversation for the same external channel session', () => {
    const first = service.getOrCreateExternalConversation({
      channelType: 'weixin',
      externalSessionId: 'wx-user-1',
    });
    const second = service.getOrCreateExternalConversation({
      channelType: 'weixin',
      externalSessionId: 'wx-user-1',
    });

    assert.equal(second.id, first.id);
  });

  it('stores channel messages as shared conversation history', () => {
    const conversation = service.getOrCreateExternalConversation({
      channelType: 'weixin',
      externalSessionId: 'wx-user-2',
    });

    service.appendUserMessage(conversation.id, '介绍一下知识库地址');
    service.appendAssistantMessage(conversation.id, '知识库地址是当前配置的 vault 路径。', {
      agentId: 'claude',
      runId: 'run-1',
    });

    const history = service.listHistory(conversation.id);
    assert.equal(history.length, 2);
    assert.equal(history[0]!.role, 'user');
    assert.equal(history[0]!.content, '介绍一下知识库地址');
    assert.equal(history[1]!.role, 'assistant');
    assert.equal(history[1]!.agentId, 'claude');
    assert.equal(history[1]!.runId, 'run-1');
  });
});
