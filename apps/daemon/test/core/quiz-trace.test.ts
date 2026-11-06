import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  openDatabase, closeDatabase, createProject, createConversation,
  createDesktopConversation, upsertMessage, listConversationHistory,
} from '../../src/core/db.js';
import { quizTracesByConversation } from '../../src/core/quiz-trace.js';
import type Database from 'better-sqlite3';

const F = '```';
/** 一张合法题卡（judge 题：options 省略，走 judge 默认项）。 */
const CARD = JSON.stringify({
  version: 1,
  title: 't',
  questions: [{
    id: 'q1', type: 'judge', stem: '1+1=2？',
    answer: ['A'], explanation: 'e', sources: [{ path: 'p.md' }],
  }],
});

describe('quizTracesByConversation', () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-quiz-trace-'));
    db = openDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const insert = (
    conversationId: string,
    messageId: string,
    content: string,
    role: 'assistant' | 'user' = 'assistant',
  ) => {
    upsertMessage(db, conversationId, { id: messageId, role, content, timestamp: Date.now() });
  };

  it('counts a quiz card in a message', () => {
    const c = createDesktopConversation(db, 'with-card', null);
    insert(c.id, 'm1', `${F}quiz\n${CARD}\n${F}`);

    const traces = quizTracesByConversation(db, [c.id]);
    assert.equal(traces.get(c.id)?.cardCount, 1);
    assert.equal(traces.get(c.id)?.correctCount, 0);
  });

  it('counts two cards in one message', () => {
    const c = createDesktopConversation(db, 'two-cards', null);
    insert(c.id, 'm1', `${F}quiz\n${CARD}\n${F}\n${F}quiz\n${CARD}\n${F}`);

    assert.equal(quizTracesByConversation(db, [c.id]).get(c.id)?.cardCount, 2);
  });

  it('ignores fences that do not render a card', () => {
    const c = createDesktopConversation(db, 'not-cards', null);
    insert(c.id, 'm1', `${F}Quiz\n${CARD}\n${F}`);        // 大小写不符
    insert(c.id, 'm2', `${F}quiz\nnot json\n${F}`);        // JSON 非法
    insert(c.id, 'm3', `${F}quiz\n${CARD}`);              // 围栏未闭合
    insert(c.id, 'm4', `${F}quizfoo\n${CARD}\n${F}`);     // 语言名不是 quiz
    insert(c.id, 'm5', `${F}quiz\n{"version":1,"title":"t","questions":[]}\n${F}`); // 空题

    assert.equal(quizTracesByConversation(db, [c.id]).get(c.id)?.cardCount, 0);
  });

  it('ignores a quiz fence nested in a code block', () => {
    const c = createDesktopConversation(db, 'nested', null);
    insert(c.id, 'm1', `${F}markdown\n示例：\n${F}quiz\n${CARD}\n${F}\n${F}`);

    assert.equal(quizTracesByConversation(db, [c.id]).get(c.id)?.cardCount, 0);
  });

  it('does not count cards in user messages', () => {
    const c = createDesktopConversation(db, 'user-card', null);
    insert(c.id, 'm1', `${F}quiz\n${CARD}\n${F}`, 'user');

    assert.equal(quizTracesByConversation(db, [c.id]).get(c.id)?.cardCount, 0);
  });

  it('counts correct answers once per question, keeping the latest attempt', () => {
    const c = createDesktopConversation(db, 'attempts', null);
    insert(c.id, 'm1', `${F}quiz\n${CARD}\n${F}`);
    const ins = db.prepare(
      `INSERT INTO quiz_attempts
         (vault_id, quiz_fingerprint, question_id, chosen, correct, conversation_id, answered_at)
       VALUES (NULL, ?, ?, '["A"]', ?, ?, ?)`,
    );
    ins.run('fp1', 'q1', 0, c.id, 100);  // 第一次答错
    ins.run('fp1', 'q1', 1, c.id, 200);  // 重做答对

    const trace = quizTracesByConversation(db, [c.id]).get(c.id);
    assert.equal(trace?.cardCount, 1);
    assert.equal(trace?.correctCount, 1);
  });

  it('counts a wrong answer as zero correct', () => {
    const c = createDesktopConversation(db, 'wrong', null);
    db.prepare(
      `INSERT INTO quiz_attempts
         (vault_id, quiz_fingerprint, question_id, chosen, correct, conversation_id, answered_at)
       VALUES (NULL, 'fp1', 'q1', '["B"]', 0, ?, 100)`,
    ).run(c.id);

    assert.equal(quizTracesByConversation(db, [c.id]).get(c.id)?.correctCount, 0);
  });

  it('reports zero for conversations without quizzes', () => {
    const c = createDesktopConversation(db, 'plain', null);
    insert(c.id, 'm1', '普通消息');

    const trace = quizTracesByConversation(db, [c.id]).get(c.id);
    assert.equal(trace?.cardCount, 0);
    assert.equal(trace?.correctCount, 0);
  });

  it('does not count cards in channel conversations', () => {
    // 渠道会话里模型吐出的 quiz 围栏是纯文本（那边不渲染题卡、也无处作答），
    // 标成「做过题」是假的。
    const p = createProject(db, 'P');
    const id = 'chan-1';
    db.prepare(
      `INSERT INTO conversations
         (id, project_id, title, channel_type, external_session_id, created_at, updated_at)
       VALUES (?, ?, 'weixin', 'weixin', 's1', 1, 1)`,
    ).run(id, p.id);
    insert(id, 'm1', `${F}quiz\n${CARD}\n${F}`);
    db.prepare(
      `INSERT INTO quiz_attempts
         (vault_id, quiz_fingerprint, question_id, chosen, correct, conversation_id, answered_at)
       VALUES (NULL, 'fp1', 'q1', '["A"]', 1, ?, 100)`,
    ).run(id);

    const trace = quizTracesByConversation(db, [id]).get(id);
    assert.equal(trace?.cardCount, 0);
    assert.equal(trace?.correctCount, 0);
  });
});

describe('listConversationHistory exposes quiz traces', () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-hist-quiz-'));
    db = openDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fills quizCardCount / quizCorrectCount on history items', () => {
    const p = createProject(db, 'P');
    const withQuiz = createConversation(db, p.id, 'made a quiz');
    const plain = createConversation(db, p.id, 'plain talk');
    upsertMessage(db, withQuiz.id, {
      id: 'qm', role: 'assistant', content: `${F}quiz\n${CARD}\n${F}`, timestamp: Date.now(),
    });
    upsertMessage(db, plain.id, {
      id: 'pm', role: 'assistant', content: '你好', timestamp: Date.now(),
    });

    const page = listConversationHistory(db);
    const quizItem = page.items.find((i) => i.conversation.id === withQuiz.id);
    const plainItem = page.items.find((i) => i.conversation.id === plain.id);
    assert.equal(quizItem?.quizCardCount, 1);
    assert.equal(quizItem?.quizCorrectCount, 0);
    assert.equal(plainItem?.quizCardCount, 0);
    assert.equal(plainItem?.quizCorrectCount, 0);
  });
});
