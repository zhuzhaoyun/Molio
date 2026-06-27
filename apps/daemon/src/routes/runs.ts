import { Hono } from 'hono';
import type { CreateRunRequest } from '@molio/contracts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RunManager } from '../core/RunManager.js';
import type { ConversationService } from '../core/conversations/service.js';
import { getVaultByPath, addKbHistory } from '../core/db.js';
import {
  WIKI_QUERY_PROMPT,
  WIKI_BUILD_PROMPT,
  WIKI_INGEST_PROMPT,
  WIKI_LINT_PROMPT,
  WIKI_SAVE_PROMPT,
  QUERY_SYS_PROMPT_FILE,
} from '../core/wiki-prompts.js';

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
      // Build conversation title — for file-specific Q&A, prefix with filename.
      // Guard against an empty filePath: split('/').pop() returns '' (not
      // undefined), so ?? wouldn't catch it — use a truthiness check.
      const fileBase = body.wikiExtra?.filePath ? body.wikiExtra.filePath.split('/').pop() : undefined;
      const convTitle = fileBase
        ? `📄 ${fileBase}：${body.message.slice(0, 80)}`
        : body.message.slice(0, 80);
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

      // If cwd matches a vault, inject wiki query prompt so the agent
      // operates as a wiki knowledge assistant for that vault. The wiki frame
      // is passed as the agent's SYSTEM prompt (via --append-system-prompt),
      // not prepended to the user message — this lets the agent use its native
      // retrieval judgment on the actual query instead of being role-locked
      // into a prescribed path. Multi-turn follow-ups reuse the live process,
      // which already carries this from the first turn.
      let message = body.message;
      let appendSystemPromptFile: string | undefined;

      // Handle explicit wiki operations — select prompt and build message
      if (body.wikiOperation) {
        const vault = body.cwd ? getVaultByPath(db, body.cwd) : null;
        if (!vault) {
          return c.json({
            error: { code: 'BAD_REQUEST', message: 'cwd must point to a vault for wiki operations' },
          }, 400);
        }

        const wikiPrompts: Record<string, string> = {
          build: WIKI_BUILD_PROMPT,
          ingest: WIKI_INGEST_PROMPT,
          lint: WIKI_LINT_PROMPT,
          query: WIKI_QUERY_PROMPT,
          save: WIKI_SAVE_PROMPT,
        };

        const prompt = wikiPrompts[body.wikiOperation];
        if (!prompt) {
          return c.json({
            error: { code: 'BAD_REQUEST', message: `Unknown wiki operation: ${body.wikiOperation}` },
          }, 400);
        }

        switch (body.wikiOperation) {
          case 'build':
            message = `${prompt}\n\n---\n\n请现在开始构建 Wiki。扫描 vault 中所有源文件并创建 wiki。`;
            addKbHistory(db, vault.id, 'ingest', 'Wiki 构建已启动');
            break;
          case 'ingest':
            message = `${prompt}\n\n---\n\n请将以下文件导入 wiki：${body.wikiExtra?.filePath ?? body.message}`;
            addKbHistory(db, vault.id, 'ingest', `已导入 "${body.wikiExtra?.filePath ?? ''}"`);
            break;
          case 'lint':
            message = `${prompt}\n\n---\n\n请现在对 wiki 进行健康检查。`;
            addKbHistory(db, vault.id, 'lint', 'Wiki 健康检查已启动');
            break;
          case 'query':
            // Wiki Q&A frame lives in the system prompt (file); the user's
            // question is the clean user message.
            message = body.message;
            appendSystemPromptFile = QUERY_SYS_PROMPT_FILE;
            break;
          case 'save':
            message = `${prompt}\n\n---\n\n${body.message || '请回顾当前对话，将值得归档的内容保存为 wiki 页面。'}`;
            addKbHistory(db, vault.id, 'edit', 'Wiki 归档已启动');
            break;
        }
      } else if (body.cwd) {
        const vault = getVaultByPath(db, body.cwd);
        if (vault) {
          // Vault-context conversation: pass the wiki query frame (file) as
          // the system prompt. Applied on every vault createRun (not just the
          // first turn) because the frame no longer rides the conversation
          // transcript — a re-spawned run would otherwise lose the wiki role.
          // The system prompt is cached, so this is cheaper than the old
          // transcript-carry approach. File context (@-mentions) is carried
          // inline in the message as a markdown link — the agent reads it.
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
