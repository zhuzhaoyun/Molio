import { Hono } from 'hono';
import type { CreateRunRequest } from '@molio/contracts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { RunManager } from '../core/RunManager.js';
import type { ConversationService } from '../core/conversations/service.js';
import { getVaultByPath, addKbHistory } from '../core/db.js';
import { resolveFilePath, isTextFile } from '../core/knowledge.js';
import {
  WIKI_QUERY_PROMPT,
  WIKI_BUILD_PROMPT,
  WIKI_INGEST_PROMPT,
  WIKI_LINT_PROMPT,
  WIKI_SAVE_PROMPT,
} from '../core/wiki-prompts.js';

/** Max file size to inline into a file-Q&A prompt (kept small to bound prompt cost). */
const MAX_FILE_CHAT_SIZE = 50 * 1024; // 50KB

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
            try {
              // Resolve within the vault with path-traversal protection. A
              // malicious filePath like "../../etc/passwd" must not escape the
              // vault root. resolveFilePath throws on traversal; that error
              // falls through to the catch below and is treated as
              // "not accessible" so neither the file nor the traversal
              // attempt is leaked to the caller.
              const fileAbsPath = resolveFilePath(vault.path, body.wikiExtra.filePath);
              const stat = await fs.promises.stat(fileAbsPath);
              if (!stat.isFile()) {
                // Not a regular file (e.g. a directory).
                message = `用户正在知识库中查看文件 "${body.wikiExtra.filePath}"，但它不是一个常规文件，无法读取内容。

用户问题：${message}

请告知用户该路径不是文件，建议在知识库中选择一个具体文件。`;
              } else if (stat.size > MAX_FILE_CHAT_SIZE) {
                // Large file: note the file but don't include full content
                message = `用户正在知识库中查看文件 "${body.wikiExtra.filePath}"，但该文件过大（>50KB），未加载完整内容。

用户问题：${message}

请告知用户文件过大无法整体加载，建议在知识库编辑器中打开，或针对文件特定部分提问。`;
              } else if (!isTextFile(fileAbsPath)) {
                // Binary file (image/pdf/docx) — reading as UTF-8 would inject
                // garbage into the prompt, so refuse rather than embed bytes.
                message = `用户正在知识库中查看文件 "${body.wikiExtra.filePath}"，但该文件不是文本格式，无法读取内容。

用户问题：${message}

请告知用户该文件无法以文本形式读取，建议在知识库中预览。`;
              } else {
                const fileContent = await fs.promises.readFile(fileAbsPath, 'utf-8');
                message = `用户正在知识库中查看文件 "${body.wikiExtra.filePath}"，并围绕该文件提问。

=== 文件 "${body.wikiExtra.filePath}" 的完整内容 ===

${fileContent}

=== 文件内容结束 ===

用户问题：${message}

请基于上面这个文件的内容直接回答。需要引用具体段落时直接引用原文。用户已通过"询问此文件"指定了要讨论的文件，无需建议查看其他文件或 wiki 页面。`;
              }
            } catch (err) {
              // File not found, traversal attempt, or read failure — log the
              // real cause and let the agent know the file is unavailable.
              console.error('[runs] file chat read failed:', err);
              message = `用户尝试讨论知识库中的文件 "${body.wikiExtra.filePath}"，但该文件不存在或无法访问。

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
