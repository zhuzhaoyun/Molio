import { Hono } from 'hono';
import type { AgentEvent, CreateRunRequest } from '@molio/contracts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RunManager } from '../core/RunManager.js';
import type { ConversationService } from '../core/conversations/service.js';
import { getVaultByPath } from '../core/db.js';
import { WIKI_QUERY_PROMPT } from '../core/wiki-prompts.js';

export function runsRoutes(
  db: Database.Database,
  runManager: RunManager,
  conversations: ConversationService,
): Hono {
  const app = new Hono();

  // POST /api/runs — create a new run
  app.post('/', async (c) => {
    const body = await c.req.json<CreateRunRequest>();

    if (!body.agentId || !body.message) {
      return c.json({
        error: { code: 'BAD_REQUEST', message: 'agentId and message are required' },
      }, 400);
    }

    try {
      const conversation = body.conversationId
        ? conversations.getConversation(body.conversationId)
        : conversations.createDesktopConversation(body.message.slice(0, 80));
      if (!conversation) {
        return c.json({
          error: { code: 'NOT_FOUND', message: 'Conversation not found' },
        }, 404);
      }

      conversations.appendMessage(conversation.id, {
        id: randomUUID(),
        role: 'user',
        content: body.message,
        timestamp: Date.now(),
        agentId: body.agentId,
      });

      // If cwd matches a vault, inject wiki query prompt so the agent
      // operates as a wiki knowledge assistant for that vault.
      // Only inject on the FIRST turn (no history) — subsequent turns
      // already carry the prompt via conversation transcript.
      let message = body.message;
      if (body.cwd && (!body.history || body.history.length === 0)) {
        const vault = getVaultByPath(db, body.cwd);
        if (vault) {
          message = `${WIKI_QUERY_PROMPT}\n\n---\n\n用户问题：${message}`;
        }
      }

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        model: body.model,
        cwd: body.cwd,
        conversationId: conversation.id,
        history: body.history,
      });
      persistAssistantReply(runManager, conversations, runId, conversation.id, body.agentId);
      return c.json({
        runId,
        conversationId: conversation.id,
      }, 201);
    } catch (err) {
      return c.json({
        error: { code: 'CREATE_FAILED', message: (err as Error).message },
      }, 500);
    }
  });

  // GET /api/runs — list all runs
  app.get('/', (c) => {
    const runs = runManager.listRuns();
    return c.json({ runs });
  });

  // GET /api/runs/:id — get run info
  app.get('/:id', (c) => {
    const runInfo = runManager.getRunInfo(c.req.param('id'));
    if (!runInfo) {
      return c.json({
        error: { code: 'NOT_FOUND', message: `Run not found: ${c.req.param('id')}` },
      }, 404);
    }
    return c.json(runInfo);
  });

  // POST /api/runs/:id/messages — send follow-up message (multi-turn)
  app.post('/:id/messages', async (c) => {
    const body = await c.req.json<{ message: string }>();
    if (!body.message) {
      return c.json({
        error: { code: 'BAD_REQUEST', message: 'message is required' },
      }, 400);
    }
    try {
      const runId = c.req.param('id');
      const runContext = runManager.getRunContext(runId);
      if (runContext?.conversationId) {
        conversations.appendMessage(runContext.conversationId, {
          id: randomUUID(),
          role: 'user',
          content: body.message,
          timestamp: Date.now(),
          agentId: runContext.agentId,
        });
      }
      const afterEventId = runManager.getLastEventId(runId);
      runManager.sendMessage(runId, body.message);
      if (runContext?.conversationId) {
        persistAssistantReply(
          runManager,
          conversations,
          runId,
          runContext.conversationId,
          runContext.agentId,
          afterEventId,
        );
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({
        error: { code: 'SEND_FAILED', message: (err as Error).message },
      }, 400);
    }
  });

  // DELETE /api/runs/:id — cancel a run
  app.delete('/:id', (c) => {
    runManager.cancelRun(c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}

function persistAssistantReply(
  runManager: RunManager,
  conversations: ConversationService,
  runId: string,
  conversationId: string,
  agentId: string,
  afterEventId = 0,
): void {
  let text = '';
  let finished = false;
  let unsubscribe: (() => void) | null = null;

  const finish = (content: string) => {
    if (finished) return;
    finished = true;
    unsubscribe?.();
    const trimmed = content.trim();
    if (!trimmed) return;
    conversations.appendMessage(conversationId, {
      id: randomUUID(),
      role: 'assistant',
      content: trimmed,
      timestamp: Date.now(),
      agentId,
      runId,
    });
  };

  const handleEvent = (event: AgentEvent) => {
    if (runManager.getLastEventId(runId) <= afterEventId) return;
    handleReplyEvent(event);
  };

  const handleReplyEvent = (event: AgentEvent) => {
    if (event.type === 'text_delta') {
      text += event.delta;
      return;
    }
    if (event.type === 'error') {
      finish(`Molio 处理失败：${event.message}`);
      return;
    }
    if (event.type === 'turn_end' && event.stopReason !== 'tool_use') {
      finish(text);
      return;
    }
    if (event.type === 'status' && event.label === 'failed') {
      finish(text || 'Molio 运行失败。');
      return;
    }
    if (event.type === 'status' && event.label === 'completed') {
      finish(text);
    }
  };

  const buffered = runManager.getBufferedEvents(runId, afterEventId) ?? [];
  for (const record of buffered) {
    handleReplyEvent(record.data as AgentEvent);
    if (finished) return;
  }
  if (runManager.isTerminal(runId)) return;

  unsubscribe = runManager.onEvent(runId, handleEvent);
}
