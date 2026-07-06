import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@molio/contracts';
import type { RunManager } from '../RunManager.js';
import { getVaultByPath } from '../db.js';
import { QUERY_SYS_PROMPT_FILE } from '../wiki-prompts.js';
import type { ConversationService } from './service.js';

export interface StartRunOptions {
  agentId: string;
  message: string;
  conversationId: string;
  history?: ChatMessage[];
  cwd?: string;
  model?: string;
}

/**
 * Shared "start a run inside an existing conversation" logic used by both
 * `POST /api/runs` (fresh turn) and `POST /api/conversations/:id/rewind-resend`
 * (regenerate/edit). Appends the user message, resolves the vault wiki system
 * prompt from cwd, and creates the run with an onTurnComplete that persists
 * the assistant reply.
 */
export async function startConversationRun(
  db: Database.Database,
  conversations: ConversationService,
  runManager: RunManager,
  opts: StartRunOptions,
): Promise<string> {
  let appendSystemPromptFile: string | undefined;
  if (opts.cwd) {
    const vault = getVaultByPath(db, opts.cwd);
    if (vault) appendSystemPromptFile = QUERY_SYS_PROMPT_FILE;
  }

  conversations.appendMessage(opts.conversationId, {
    id: randomUUID(),
    role: 'user',
    content: opts.message,
    timestamp: Date.now(),
    agentId: opts.agentId,
  });

  const conversationId = opts.conversationId;
  const agentId = opts.agentId;

  return runManager.createRun({
    agentId,
    message: opts.message,
    appendSystemPromptFile,
    model: opts.model,
    cwd: opts.cwd,
    conversationId,
    history: opts.history,
    onTurnComplete: (text, rid) => {
      // Defense-in-depth: if the run has already been cancelled (e.g. by the
      // rewind-resend endpoint), drop the late reply so it cannot land after
      // the new user message and produce an orphan assistant turn. cancelRun
      // sets run.status = 'canceled' synchronously, so isTerminal returns true
      // immediately.
      if (runManager.isTerminal(rid)) return;
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
}
