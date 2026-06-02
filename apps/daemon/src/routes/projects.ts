import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { CreateProjectRequest, CreateConversationRequest, ChatMessage } from '@kge/contracts';
import {
  listProjects,
  getProject,
  createProject,
  deleteProject,
  listConversations,
  getConversation,
  createConversation,
  deleteConversation,
  listMessages,
  upsertMessage,
} from '../core/db.js';

export function projectRoutes(db: Database.Database): Hono {
  const app = new Hono();

  // GET /api/projects — list all projects
  app.get('/', (c) => {
    const projects = listProjects(db);
    return c.json({ projects });
  });

  // POST /api/projects — create a project
  app.post('/', async (c) => {
    const body = await c.req.json<CreateProjectRequest>();
    if (!body.name) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'name is required' } }, 400);
    }
    const project = createProject(db, body.name, body.metadata);
    return c.json(project, 201);
  });

  // GET /api/projects/:id — get a project
  app.get('/:id', (c) => {
    const project = getProject(db, c.req.param('id'));
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
    }
    return c.json(project);
  });

  // DELETE /api/projects/:id — delete a project (cascades to conversations + messages)
  app.delete('/:id', (c) => {
    deleteProject(db, c.req.param('id'));
    return c.body(null, 204);
  });

  // ─── Conversations ───

  // GET /api/projects/:id/conversations — list conversations
  app.get('/:id/conversations', (c) => {
    const conversations = listConversations(db, c.req.param('id'));
    return c.json({ conversations });
  });

  // POST /api/projects/:id/conversations — create a conversation
  app.post('/:id/conversations', async (c) => {
    let title: string | undefined;
    try {
      const body = await c.req.json<CreateConversationRequest>();
      title = body.title;
    } catch {
      // No body or invalid JSON — create with no title
    }
    const conversation = createConversation(db, c.req.param('id'), title);
    return c.json(conversation, 201);
  });

  // GET /api/projects/:pid/conversations/:cid — get a conversation
  app.get('/:pid/conversations/:cid', (c) => {
    const conversation = getConversation(db, c.req.param('cid'));
    if (!conversation) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }, 404);
    }
    return c.json(conversation);
  });

  // DELETE /api/projects/:pid/conversations/:cid — delete a conversation
  app.delete('/:pid/conversations/:cid', (c) => {
    deleteConversation(db, c.req.param('cid'));
    return c.body(null, 204);
  });

  // ─── Messages ───

  // GET /api/projects/:pid/conversations/:cid/messages — list messages
  app.get('/:pid/conversations/:cid/messages', (c) => {
    const messages = listMessages(db, c.req.param('cid'));
    return c.json({ messages });
  });

  // PUT /api/projects/:pid/conversations/:cid/messages/:mid — upsert a message
  app.put('/:pid/conversations/:cid/messages/:mid', async (c) => {
    const body = await c.req.json<ChatMessage>();
    upsertMessage(db, c.req.param('cid'), body);
    return c.json({ ok: true });
  });

  return app;
}
