import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  openDatabase,
  closeDatabase,
  createProject,
  createConversation,
  upsertMessage,
  listConversationHistory,
} from '../../src/core/db.js';
import type { ChatMessage } from '@molio/contracts';
import type Database from 'better-sqlite3';

describe('listConversationHistory lastMessage', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-last-msg-test-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return the assistant message as the last message', () => {
    const project = createProject(db, 'Last Message Test');
    const conv = createConversation(db, project.id, 'Test Conv');

    const userMsg: ChatMessage = {
      id: 'user-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Hi there!',
      timestamp: Date.now() + 1000,
    };

    upsertMessage(db, conv.id, userMsg);
    upsertMessage(db, conv.id, assistantMsg);

    const history = listConversationHistory(db).items;
    const item = history.find((h) => h.conversation.id === conv.id);

    assert.ok(item, 'Conversation should be in history');
    assert.ok(item!.lastMessage, 'lastMessage should be present');
    assert.equal(item!.lastMessage!.role, 'assistant');
    assert.equal(item!.lastMessage!.content, 'Hi there!');
  });

  it('should update lastMessage when a new assistant reply is added', () => {
    const project = createProject(db, 'Last Message Update Test');
    const conv = createConversation(db, project.id, 'Update Conv');

    upsertMessage(db, conv.id, {
      id: 'user-2',
      role: 'user',
      content: 'First question',
      timestamp: Date.now(),
    });

    upsertMessage(db, conv.id, {
      id: 'assistant-2',
      role: 'assistant',
      content: 'First answer',
      timestamp: Date.now() + 1000,
    });

    upsertMessage(db, conv.id, {
      id: 'user-3',
      role: 'user',
      content: 'Second question',
      timestamp: Date.now() + 2000,
    });

    upsertMessage(db, conv.id, {
      id: 'assistant-3',
      role: 'assistant',
      content: 'Second answer',
      timestamp: Date.now() + 3000,
    });

    const history = listConversationHistory(db).items;
    const item = history.find((h) => h.conversation.id === conv.id);

    assert.ok(item, 'Conversation should be in history');
    assert.ok(item!.lastMessage, 'lastMessage should be present');
    assert.equal(item!.lastMessage!.role, 'assistant');
    assert.equal(item!.lastMessage!.content, 'Second answer');
  });
});
