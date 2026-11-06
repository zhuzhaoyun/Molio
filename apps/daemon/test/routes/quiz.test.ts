import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import { quizRoutes } from '../../src/routes/quiz.js';

let dir: string;
let db: ReturnType<typeof openDatabase>;
let app: Hono;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-quiz-routes-'));
  db = openDatabase(dir);
  app = new Hono().route('/api/quiz', quizRoutes(db));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

function post(body: unknown) {
  return app.request('/api/quiz/attempts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = {
  vaultId: 'vault-1',
  quizFingerprint: 'a'.repeat(64),
  conversationId: 'conv-1',
  attempts: [
    { questionId: 'q1', chosen: ['B'], correct: true },
    { questionId: 'q2', chosen: ['A', 'B'], correct: false },
  ],
};

describe('quiz_attempts migration', () => {
  it('creates the table and index on open', () => {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quiz_attempts'",
    ).get();
    assert.ok(table, 'quiz_attempts table exists');
    const index = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_quiz_attempts_fp'",
    ).get();
    assert.ok(index, 'fingerprint index exists');
  });
});

describe('POST /api/quiz/attempts', () => {
  it('inserts a whole batch', async () => {
    const res = await post(VALID);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, inserted: 2 });

    const rows = db.prepare('SELECT * FROM quiz_attempts ORDER BY id').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.vault_id, 'vault-1');
    assert.equal(rows[0]!.quiz_fingerprint, 'a'.repeat(64));
    assert.equal(rows[0]!.question_id, 'q1');
    assert.equal(rows[0]!.chosen, '["B"]');
    assert.equal(rows[0]!.correct, 1);
    assert.equal(rows[0]!.conversation_id, 'conv-1');
    assert.equal(typeof rows[0]!.answered_at, 'number');
    assert.equal(rows[1]!.correct, 0);
  });

  it('accepts null vaultId / conversationId', async () => {
    const res = await post({ ...VALID, vaultId: null, conversationId: null });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT vault_id, conversation_id FROM quiz_attempts LIMIT 1').get() as Record<string, unknown>;
    assert.equal(row.vault_id, null);
    assert.equal(row.conversation_id, null);
  });

  it('rejects an empty attempts array', async () => {
    const res = await post({ ...VALID, attempts: [] });
    assert.equal(res.status, 400);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts').get() as { n: number }).n, 0);
  });

  it('rejects more than 100 attempts', async () => {
    const attempts = Array.from({ length: 101 }, (_, i) => ({
      questionId: `q${i}`, chosen: ['A'], correct: true,
    }));
    const res = await post({ ...VALID, attempts });
    assert.equal(res.status, 400);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts').get() as { n: number }).n, 0);
  });

  it('rejects a missing fingerprint', async () => {
    const res = await post({ ...VALID, quizFingerprint: '' });
    assert.equal(res.status, 400);
  });

  it('rejects a non-boolean correct value', async () => {
    const res = await post({
      ...VALID,
      attempts: [{ questionId: 'q1', chosen: ['A'], correct: 'yes' }],
    });
    assert.equal(res.status, 400);
  });

  it('rejects an invalid attempt in the middle without writing any row', async () => {
    const res = await post({
      ...VALID,
      attempts: [
        { questionId: 'q1', chosen: ['A'], correct: true },
        { questionId: 'q2', chosen: [], correct: true },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts').get() as { n: number }).n, 0);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await app.request('/api/quiz/attempts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});
