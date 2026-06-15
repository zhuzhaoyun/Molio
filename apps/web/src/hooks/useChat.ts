/**
 * useChat — home page chat hook.
 *
 * Wraps useChatCore with:
 *  - DB persistence (saveMessage)
 *  - Conversation ID management
 *  - History loading (loadConversation)
 *  - api.createRun() as the run creator
 */

import { useCallback } from 'react';
import { api } from '../api/client';
import { useChatCore } from './useChatCore';
import type { ChatMessage } from './useChatCore';

export type { ChatMessage, ToolEvent } from './useChatCore';

interface UseChatOptions {
  agentId: string | null;
  conversationId?: string | null;
  initialMessages?: ChatMessage[];
  cwd?: string | null;
}

export function useChat(options: UseChatOptions | string | null) {
  // Support both old API (useChat(agentId)) and new API (useChat({ agentId, ... }))
  const agentId = typeof options === 'string' || options === null ? options : options.agentId;
  const initialConversationId = typeof options === 'object' && options !== null ? options.conversationId : null;
  const cwd = typeof options === 'object' && options !== null ? options.cwd : null;

  const core = useChatCore({
    agentId,
    initialMessages: typeof options === 'object' && options !== null ? options.initialMessages : undefined,
    initialConversationId: initialConversationId ?? null,
    createRun: async ({ message, history, conversationId }) => {
      // Map to contracts ChatMessage type (strips 'error' role)
      const contractHistory = history
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
        message,
        conversationId: conversationId ?? undefined,
        history: contractHistory.length > 0 ? contractHistory : undefined,
        cwd: cwd ?? undefined,
      });

      return result;
    },
  });

  /**
   * Load a conversation from DB and populate the chat state.
   */
  const loadConversation = useCallback(async (
    projId: string,
    convId: string,
  ) => {
    try {
      const messages = projId
        ? await api.listMessages(projId, convId)
        : await api.listConversationMessages(convId);
      const chatMessages: ChatMessage[] = messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: m.timestamp,
        agentId: m.agentId,
        runId: m.runId,
        tools: m.tools as ChatMessage['tools'],
        usage: m.usage,
      }));

      core.setMessages(chatMessages, convId);
    } catch (err) {
      console.error('Failed to load conversation:', err);
      core.setMessages([], convId);
    }
  }, [core.setMessages]);

  const loadConversationById = useCallback(async (convId: string) => {
    await loadConversation('', convId);
  }, [loadConversation]);

  return {
    messages: core.messages,
    runId: core.runId,
    isRunning: core.isRunning,
    conversationId: core.conversationId,
    send: core.send,
    submitToolResult: core.submitToolResult,
    cancel: core.cancel,
    reset: core.reset,
    loadConversation,
    loadConversationById,
  };
}
