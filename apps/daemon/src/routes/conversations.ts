import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { RewindResendRequest, DeleteMessagesRequest } from '@molio/contracts';
import type { RunManager } from '../core/RunManager.js';
import type { ConversationService } from '../core/conversations/service.js';
import { startConversationRun } from '../core/conversations/run-starter.js';
import {
  deleteConversation,
  getConversation,
  getRewindPoint,
  deleteMessagesFromPosition,
  deleteMessagesById,
  listMessagesBefore,
  listConversationHistory,
  listMessages,
} from '../core/db.js';

export function conversationRoutes(
  db: Database.Database,
  runManager: RunManager,
  conversations: ConversationService,
): Hono {
  const app = new Hono();

  // GET /api/conversations — list global conversation history
  app.get('/', (c) => {
    const conversations = listConversationHistory(db, 200);
    return c.json({ conversations });
  });

  // GET /api/conversations/:id — get a single conversation
  app.get('/:id', (c) => {
    const conversation = getConversation(db, c.req.param('id'));
    if (!conversation) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
    }
    return c.json(conversation);
  });

  // GET /api/conversations/:id/messages — list all messages
  app.get('/:id/messages', (c) => {
    const messages = listMessages(db, c.req.param('id'));
    return c.json({ messages });
  });

  // DELETE /api/conversations/:id — delete a conversation
  app.delete('/:id', (c) => {
    deleteConversation(db, c.req.param('id'));
    return c.body(null, 204);
  });

  // POST /api/conversations/:id/rewind-resend — regenerate or edit-and-resend
  // the last user message. Server-side locates the rewind point (last user msg
  // position), cancels any live run, truncates, and starts a fresh run with the
  // surviving history.
  app.post('/:id/rewind-resend', async (c) => {
    const convId = c.req.param('id');
    const body = await c.req.json<RewindResendRequest>();

    if (!body.newContent || !body.newContent.trim()) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'newContent is required' } }, 400);
    }

    const conv = getConversation(db, convId);
    if (!conv) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
    }

    const point = getRewindPoint(db, convId);
    if (!point) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'No user message to rewind to' } }, 400);
    }

    // Cancel the active run if it is still alive (streaming). The active run is
    // the one that produced the most recent assistant message.
    if (
      point.activeRunId &&
      runManager.getRunContext(point.activeRunId) &&
      !runManager.isTerminal(point.activeRunId)
    ) {
      runManager.cancelRun(point.activeRunId);
    }

    // Resolve agentId: body > last assistant message's agentId.
    let agentId = body.agentId;
    if (!agentId) {
      const recent = listMessages(db, convId)
        .filter((m) => m.role === 'assistant' && m.agentId)
        .at(-1);
      agentId = recent?.agentId;
    }
    if (!agentId) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'agentId could not be determined' } }, 400);
    }

    // Surviving history (everything before the last user message).
    const history = listMessagesBefore(db, convId, point.position);

    // Truncate DB AFTER history is read (history query is position-bounded so
    // order doesn't matter, but read-then-delete avoids any window ambiguity).
    deleteMessagesFromPosition(db, convId, point.position);

    try {
      const runId = await startConversationRun(db, conversations, runManager, {
        agentId,
        message: body.newContent.trim(),
        conversationId: convId,
        history,
        cwd: body.cwd,
      });
      return c.json({ runId, conversationId: convId }, 200);
    } catch (err) {
      return c.json({
        error: { code: 'REWIND_FAILED', message: (err as Error).message },
      }, 500);
    }
  });

  // POST /api/conversations/:id/delete-messages — delete a set of messages by id.
  app.post('/:id/delete-messages', async (c) => {
    const convId = c.req.param('id');
    const body = await c.req.json<DeleteMessagesRequest>();
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'ids must be a non-empty array' } }, 400);
    }
    const conv = getConversation(db, convId);
    if (!conv) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
    }
    const deleted = deleteMessagesById(db, convId, body.ids);
    return c.json({ deleted });
  });

  return app;
}
