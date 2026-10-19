import { Hono } from 'hono';
import type Database from 'better-sqlite3';

interface AttemptRow {
  vaultId: string | null;
  quizFingerprint: string;
  questionId: string;
  chosen: string;
  correct: number;
  conversationId: string | null;
  answeredAt: number;
}

type ParsedBody =
  | { ok: true; rows: AttemptRow[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): ParsedBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be an object' };

  const fingerprint = body.quizFingerprint;
  if (typeof fingerprint !== 'string' || !fingerprint.trim()) {
    return { ok: false, error: 'quizFingerprint is required' };
  }
  if (fingerprint.length > 128) {
    return { ok: false, error: 'quizFingerprint is too long' };
  }

  const attempts = body.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { ok: false, error: 'attempts must be a non-empty array' };
  }
  if (attempts.length > 100) {
    return { ok: false, error: 'too many attempts (max 100)' };
  }

  const vaultId = body.vaultId ?? null;
  if (vaultId !== null && (typeof vaultId !== 'string' || !vaultId.trim() || vaultId.length > 200)) {
    return { ok: false, error: 'invalid vaultId' };
  }
  const conversationId = body.conversationId ?? null;
  if (
    conversationId !== null
    && (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 200)
  ) {
    return { ok: false, error: 'invalid conversationId' };
  }

  const answeredAt = Date.now();
  const rows: AttemptRow[] = [];

  for (const [index, attempt] of attempts.entries()) {
    if (!isRecord(attempt)) {
      return { ok: false, error: `attempts[${index}] must be an object` };
    }
    const questionId = attempt.questionId;
    if (typeof questionId !== 'string' || !questionId.trim() || questionId.length > 200) {
      return { ok: false, error: `attempts[${index}].questionId is invalid` };
    }
    const chosen = attempt.chosen;
    if (!Array.isArray(chosen) || chosen.length === 0 || chosen.length > 8) {
      return { ok: false, error: `attempts[${index}].chosen must contain 1-8 keys` };
    }
    // key 上限 64 与 web 端 parseQuizBlock 的 MAX_QUIZ_KEY_CHARS 一致——
    // 两层不一致会让「渲染得了、落不了库」的批次整批静默丢失。
    if (!chosen.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 64)) {
      return { ok: false, error: `attempts[${index}].chosen is invalid` };
    }
    if (typeof attempt.correct !== 'boolean') {
      return { ok: false, error: `attempts[${index}].correct must be a boolean` };
    }

    rows.push({
      vaultId,
      quizFingerprint: fingerprint.trim(),
      questionId: questionId.trim(),
      chosen: JSON.stringify(chosen),
      correct: attempt.correct ? 1 : 0,
      conversationId,
      answeredAt,
    });
  }

  return { ok: true, rows };
}

export function quizRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // POST /api/quiz/attempts — 批量写入一次提交的全部题目。
  app.post('/attempts', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'invalid JSON body' } }, 400);
    }

    const parsed = parseBody(body);
    if (!parsed.ok) {
      return c.json({ error: { code: 'BAD_REQUEST', message: parsed.error } }, 400);
    }

    const insert = db.prepare(`
      INSERT INTO quiz_attempts
        (vault_id, quiz_fingerprint, question_id, chosen, correct, conversation_id, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = db.transaction((rows: AttemptRow[]) => {
      for (const row of rows) {
        insert.run(
          row.vaultId,
          row.quizFingerprint,
          row.questionId,
          row.chosen,
          row.correct,
          row.conversationId,
          row.answeredAt,
        );
      }
    });

    try {
      insertAll(parsed.rows);
    } catch (error) {
      return c.json({
        error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'insert failed' },
      }, 500);
    }

    return c.json({ ok: true, inserted: parsed.rows.length });
  });

  return app;
}
