import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import {
  deleteConversation,
  getConversation,
  listConversationHistory,
  listMessages,
} from '../core/db.js';

export function conversationRoutes(db: Database.Database): Hono {
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

  return app;
}
