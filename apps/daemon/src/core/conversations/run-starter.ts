import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@molio/contracts';
import type { RunManager } from '../RunManager.js';
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
 * (regenerate/edit). Appends the user message and creates the run with an
 * onTurnComplete that persists the assistant reply.
 *
 * Wiki retrieval is NOT injected here: it lives in the on-demand `wiki-query`
 * skill (triggered by the vault's .claude/CLAUDE.md rule + the KB qa panel),
 * replacing the old `--append-system-prompt-file` QUERY-frame injection that
 * the CLI silently dropped (the frame never reached the model).
 */
export async function startConversationRun(
  conversations: ConversationService,
  runManager: RunManager,
  opts: StartRunOptions,
): Promise<string> {
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
