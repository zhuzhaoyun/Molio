import { Hono } from 'hono';
import type { CreateRunRequest } from '@molio/contracts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RunManager } from '../core/RunManager.js';
import type { ConversationService } from '../core/conversations/service.js';
import { getVaultByPath, addKbHistory } from '../core/db.js';
import {
  WIKI_QUERY_PROMPT,
  WIKI_BUILD_PROMPT,
  WIKI_INGEST_PROMPT,
  WIKI_LINT_PROMPT,
  WIKI_SAVE_PROMPT,
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
      // Build conversation title — for file-specific Q&A, prefix with filename
      const convTitle = body.wikiExtra?.filePath
        ? `📄 ${body.wikiExtra.filePath.split('/').pop() ?? body.wikiExtra.filePath}：${body.message.slice(0, 50)}`
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
      // operates as a wiki knowledge assistant for that vault.
      // Only inject on the FIRST turn (no history) — subsequent turns
      // already carry the prompt via conversation transcript.
      let message = body.message;

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
            message = `${prompt}\n\n---\n\n用户问题：${body.message}`;
            break;
          case 'save':
            message = `${prompt}\n\n---\n\n${body.message || '请回顾当前对话，将值得归档的内容保存为 wiki 页面。'}`;
            addKbHistory(db, vault.id, 'edit', 'Wiki 归档已启动');
            break;
        }
      } else if (body.cwd && (!body.history || body.history.length === 0)) {
        const vault = getVaultByPath(db, body.cwd);
        if (vault) {
          // If a specific file is referenced via wikiExtra, read it and include as context.
          // Use a focused prompt rather than WIKI_QUERY_PROMPT — the latter instructs the
          // agent to explore the entire wiki which distracts from the specific file at hand.
          if (body.wikiExtra?.filePath) {
            const fileAbsPath = path.join(vault.path, body.wikiExtra.filePath);
            try {
              const stat = fs.statSync(fileAbsPath);
              if (stat.isFile() && stat.size <= 50 * 1024) {
                const fileContent = fs.readFileSync(fileAbsPath, 'utf-8');
                message = `你是一个专业的文档助理。用户正在 Molio 知识库中查看文件 "${body.wikiExtra.filePath}"，并围绕该文件向你提问。

=== 文件 "${body.wikiExtra.filePath}" 的完整内容 ===

${fileContent}

=== 文件内容结束 ===

用户问题：${message}

请基于上面这个文件的内容直接回答用户。如果需要引用文件中的具体段落，请直接引用。不要建议用户去查看其他文件或 wiki 页面——用户已经把要讨论的文件通过 "询问此文件" 功能提供给你了。`;
              } else if (stat.isFile()) {
                // Large file: note the file but don't include full content
                message = `你是一个专业的文档助理。用户正在 Molio 知识库中查看文件 "${body.wikiExtra.filePath}"，但该文件过大（>50KB），未能加载完整内容。

用户问题：${message}

请告知用户文件过大，并建议他们在知识库编辑器中打开文件进行查看。`;
              } else {
                message = `你是一个专业的文档助理。用户正在 Molio 知识库中查看文件 "${body.wikiExtra.filePath}"。

用户问题：${message}

请告知用户该文件不是普通文本文件，建议在知识库中预览。`;
              }
            } catch {
              // File not found — let the agent know
              message = `你是一个专业的文档助理。用户尝试在 Molio 知识库中讨论文件 "${body.wikiExtra.filePath}"，但该文件似乎不存在或无法访问。

用户问题：${message}

请告知用户文件可能已被移动或删除，建议在知识库中确认文件路径。`;
            }
          } else {
            message = `${WIKI_QUERY_PROMPT}\n\n---\n\n用户问题：${message}`;
          }
        }
      }

      const conversationId = conversation.id;
      const agentId = body.agentId;

      const runId = await runManager.createRun({
        agentId: body.agentId,
        message,
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
