import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  openDatabase,
  closeDatabase,
  listProjects,
  createProject,
  getProject,
  deleteProject,
  listConversations,
  createConversation,
  deleteConversation,
  listMessages,
  upsertMessage,
  appendMessageEvent,
} from '../src/core/db.js';
import type { ChatMessage } from '@kge/contracts';
import type Database from 'better-sqlite3';

describe('SQLite persistence', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kge-test-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('projects', () => {
    it('should create and list projects', () => {
      const project = createProject(db, 'Test Project');
      assert.ok(project.id);
      assert.equal(project.name, 'Test Project');
      assert.ok(project.createdAt > 0);

      const projects = listProjects(db);
      assert.ok(projects.length >= 1);
      assert.ok(projects.some((p) => p.id === project.id));
    });

    it('should get a project by id', () => {
      const project = createProject(db, 'Get Test');
      const fetched = getProject(db, project.id);
      assert.ok(fetched);
      assert.equal(fetched!.name, 'Get Test');
    });

    it('should return null for non-existent project', () => {
      const fetched = getProject(db, 'non-existent-id');
      assert.equal(fetched, null);
    });

    it('should delete a project', () => {
      const project = createProject(db, 'Delete Me');
      deleteProject(db, project.id);
      const fetched = getProject(db, project.id);
      assert.equal(fetched, null);
    });

    it('should store metadata as JSON', () => {
      const project = createProject(db, 'With Meta', { key: 'value', count: 42 });
      const fetched = getProject(db, project.id);
      assert.ok(fetched);
      assert.deepEqual(fetched!.metadata, { key: 'value', count: 42 });
    });
  });

  describe('conversations', () => {
    let projectId: string;

    before(() => {
      const project = createProject(db, 'Conv Test Project');
      projectId = project.id;
    });

    it('should create and list conversations', () => {
      const conv = createConversation(db, projectId, 'Test Conv');
      assert.ok(conv.id);
      assert.equal(conv.projectId, projectId);
      assert.equal(conv.title, 'Test Conv');

      const convs = listConversations(db, projectId);
      assert.ok(convs.length >= 1);
      assert.ok(convs.some((c) => c.id === conv.id));
    });

    it('should create conversation without title', () => {
      const conv = createConversation(db, projectId);
      assert.ok(conv.id);
      assert.equal(conv.title, null);
    });

    it('should delete conversation (cascades to messages)', () => {
      const conv = createConversation(db, projectId, 'Delete Conv');
      const msg: ChatMessage = {
        id: 'test-msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };
      upsertMessage(db, conv.id, msg);

      deleteConversation(db, conv.id);

      // Messages should be cascade-deleted
      const messages = listMessages(db, conv.id);
      assert.equal(messages.length, 0);
    });
  });

  describe('messages', () => {
    let projectId: string;
    let conversationId: string;

    before(() => {
      const project = createProject(db, 'Msg Test Project');
      projectId = project.id;
      const conv = createConversation(db, projectId, 'Msg Test Conv');
      conversationId = conv.id;
    });

    it('should insert and list messages in order', () => {
      const userMsg: ChatMessage = {
        id: 'msg-user-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        id: 'msg-asst-1',
        role: 'assistant',
        content: 'Hi there!',
        timestamp: Date.now(),
      };

      upsertMessage(db, conversationId, userMsg);
      upsertMessage(db, conversationId, assistantMsg);

      const messages = listMessages(db, conversationId);
      assert.ok(messages.length >= 2);
      assert.equal(messages[0]!.content, 'Hello');
      assert.equal(messages[1]!.content, 'Hi there!');
    });

    it('should update existing message (upsert)', () => {
      const msg: ChatMessage = {
        id: 'msg-update-1',
        role: 'assistant',
        content: 'Initial',
        timestamp: Date.now(),
      };
      upsertMessage(db, conversationId, msg);

      // Update content
      const updated: ChatMessage = {
        ...msg,
        content: 'Updated content',
      };
      upsertMessage(db, conversationId, updated);

      const messages = listMessages(db, conversationId);
      const found = messages.find((m) => m.id === 'msg-update-1');
      assert.ok(found);
      assert.equal(found!.content, 'Updated content');
    });

    it('should append events to events_json', () => {
      const msg: ChatMessage = {
        id: 'msg-events-1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      };
      upsertMessage(db, conversationId, msg);

      appendMessageEvent(db, 'msg-events-1', { type: 'text_delta', delta: 'Hello' }, 'Hello');
      appendMessageEvent(db, 'msg-events-1', { type: 'text_delta', delta: ' World' }, ' World');

      const messages = listMessages(db, conversationId);
      const found = messages.find((m) => m.id === 'msg-events-1');
      assert.ok(found);
      assert.equal(found!.content, 'Hello World');
    });

    it('should auto-increment position for new messages', () => {
      const conv = createConversation(db, projectId, 'Position Test');

      for (let i = 0; i < 3; i++) {
        upsertMessage(db, conv.id, {
          id: `pos-msg-${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        });
      }

      const messages = listMessages(db, conv.id);
      assert.equal(messages.length, 3);
      assert.equal(messages[0]!.content, 'Message 0');
      assert.equal(messages[1]!.content, 'Message 1');
      assert.equal(messages[2]!.content, 'Message 2');
    });
  });

  describe('foreign key cascades', () => {
    it('should cascade delete project → conversations → messages', () => {
      const project = createProject(db, 'Cascade Test');
      const conv = createConversation(db, project.id, 'Cascade Conv');
      upsertMessage(db, conv.id, {
        id: 'cascade-msg',
        role: 'user',
        content: 'Will be deleted',
        timestamp: Date.now(),
      });

      deleteProject(db, project.id);

      // Conversation should be gone
      const convs = listConversations(db, project.id);
      assert.equal(convs.length, 0);

      // Messages should be gone
      const messages = listMessages(db, conv.id);
      assert.equal(messages.length, 0);
    });
  });
});
