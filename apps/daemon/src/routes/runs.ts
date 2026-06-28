import { Hono } from 'hono';
import type { CreateRunRequest } from '@molio/contracts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RunManager } from '../core/RunManager.js';
import type { ConversationService } from '../core/conversations/service.js';
import { getVaultByPath } from '../core/db.js';
import { QUERY_SYS_PROMPT_FILE } from '../core/wiki-prompts.js';

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
      // Build conversation title from the message. (File-specific ingest
      // messages embed the file path in the text, so it surfaces in the title.)
      const convTitle = body.message.slice(0, 80);
      const conversation = body.conversationId
        ? conversations.getConversation(body.conversationId)
        : conversations.createDesktopConversation(convTitle);
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

      // If cwd matches a vault, attach the wiki query frame as the agent's
      // SYSTEM prompt (via --append-system-prompt-file). The frame is always-on
      // background (retrieval-safe per the A/B/C probe); the agent uses its
      // native retrieval on the actual query and invokes wiki-* skills
      // (build/ingest/lint/save) on demand when the user asks for an operation
      // — so chat-typed verbs and UI buttons hit the same procedure.
      let message = body.message;
      let appendSystemPromptFile: string | undefined;

      if (body.cwd) {
        const vault = getVaultByPath(db, body.cwd);
        if (vault) {
          // Applied on every vault createRun (not just the first turn) because
          // the frame no longer rides the conversation transcript — a re-spawned
          // run would otherwise lose the wiki role. The system prompt is cached,
          // so this is cheaper than the old transcript-carry approach. File
          // context (@-mentions) is carried inline in the message — the agent
          // reads it.
          appendSystemPromptFile = QUERY_SYS_PROMPT_FILE;
        }
      }

      const conversationId = conversation.id;
      const agentId = body.agentId;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
        appendSystemPromptFile,
        model: body.model,
        cwd: body.cwd,
        conversationId: conversation.id,
        history: body.history,
        onTurnComplete: (text, rid) => {
          conversations.appendMessage(conversationId, {
            id: randomUUID(),
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            agentId,
            runId: rid,
          });
        },
      });

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

      // Flush pending assistant reply BEFORE inserting user message
      // to ensure correct position ordering in the database.
      runManager.flushPendingReply(runId);

      if (runContext?.conversationId) {
        conversations.appendMessage(runContext.conversationId, {
          id: randomUUID(),
          role: 'user',
          content: body.message,
          timestamp: Date.now(),
          agentId: runContext.agentId,
        });
      }
      // onTurnComplete callback was registered during createRun() and
      // persists across turns.
      runManager.sendMessage(runId, body.message);
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
