import { useCallback, useRef } from 'react';
import { api } from '../api/client';
import { useChatCore, type ChatMessage, type CreateRunContext } from './useChatCore';

export interface UseFileChatOptions {
  /** Current agent ID — required to create runs. */
  agentId: string | null;
  /** Vault filesystem path — passed as cwd for the agent. */
  vaultPath: string | null;
  /** File path relative to vault root — passed as wikiExtra.filePath. */
  filePath: string | null;
}

export interface FileChatState {
  messages: ChatMessage[];
  isRunning: boolean;
  send: (text: string) => void;
  cancel: () => void;
  onSubmitToolResult: (toolUseId: string, content: string) => void;
}

export function useFileChat(opts: UseFileChatOptions): FileChatState {
  const { agentId, vaultPath, filePath } = opts;

  // Track whether we have an active conversation so we can reuse it
  const conversationIdRef = useRef<string | null>(null);

  const createRun = useCallback(
    async (ctx: CreateRunContext) => {
      // Map to contracts ChatMessage type (strips 'error' role)
      const contractHistory = ctx.history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          timestamp: m.timestamp,
          agentId: m.agentId,
          runId: m.runId,
          tools: m.tools,
          usage: m.usage,
        }));

      const result = await api.createRun({
        agentId: agentId!,
        message: ctx.message,
        cwd: vaultPath ?? undefined,
        conversationId: ctx.conversationId ?? conversationIdRef.current ?? undefined,
        wikiExtra: filePath ? { filePath } : undefined,
        history: contractHistory.length > 0 ? contractHistory : undefined,
      });
      // Remember conversation for multi-turn
      if (result.conversationId) {
        conversationIdRef.current = result.conversationId;
      }
      return { runId: result.runId, conversationId: result.conversationId };
    },
    [agentId, vaultPath, filePath],
  );

  const chat = useChatCore({
    createRun,
    agentId,
  });

  return {
    messages: chat.messages,
    isRunning: chat.isRunning,
    send: chat.send,
    cancel: chat.cancel,
    onSubmitToolResult: chat.submitToolResult,
  };
}
