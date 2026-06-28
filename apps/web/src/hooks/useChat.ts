/**
 * useChat — unified chat hook for both normal chat and wiki operations.
 *
 * Wraps useChatCore with:
 *  - DB persistence (saveMessage)
 *  - Conversation ID management
 *  - History loading (loadConversation)
 *  - api.createRun() as the run creator
 *  - Wiki operation support (mode: 'wiki')
 */

import { useCallback, useEffect, useRef } from 'react';
import type { WikiOperationType } from '@molio/contracts';
import { api } from '../api/client';
import { useChatCore } from './useChatCore';
import type { ChatMessage } from './useChatCore';

export type { ChatMessage, ToolEvent } from './useChatCore';

interface UseChatOptions {
  agentId: string | null;
  conversationId?: string | null;
  initialMessages?: ChatMessage[];
  cwd?: string | null;
  /** 'chat' (default) for normal chat, 'wiki' for wiki operations. */
  mode?: 'chat' | 'wiki';
  /** Required when mode='wiki'. */
  vaultId?: string | null;
  /** Called after a run completes successfully (e.g. to refresh file tree). */
  onComplete?: () => void;
}

export function useChat(options: UseChatOptions | string | null) {
  // Support both old API (useChat(agentId)) and new API (useChat({ agentId, ... }))
  const agentId = typeof options === 'string' || options === null ? options : options.agentId;
  const initialConversationId = typeof options === 'object' && options !== null ? options.conversationId : null;
  const cwd = typeof options === 'object' && options !== null ? options.cwd : null;
  const mode = typeof options === 'object' && options !== null ? (options.mode ?? 'chat') : 'chat';
  const vaultId = typeof options === 'object' && options !== null ? options.vaultId : null;
  const onComplete = typeof options === 'object' && options !== null ? options.onComplete : undefined;

  const operationTypeRef = useRef<WikiOperationType | null>(null);

  const core = useChatCore({
    agentId,
    initialMessages: typeof options === 'object' && options !== null ? options.initialMessages : undefined,
    initialConversationId: initialConversationId ?? null,
    onComplete,
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

      // Wiki operations are now invoked by the agent via wiki-* skills (no
      // backend wikiOperation field). The message text carries any trigger
      // words / file path; the agent loads the matching skill on demand.
      return api.createRun({
        agentId: agentId!,
        message,
        conversationId: conversationId ?? undefined,
        history: contractHistory.length > 0 ? contractHistory : undefined,
        cwd: cwd ?? undefined,
      });
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

  // Auto-restore messages from DB when conversationId exists but messages are empty.
  // This handles page refresh or any scenario where React state is reset.
  useEffect(() => {
    if (core.messages.length > 0) return;
    if (!core.conversationId) return;
    void loadConversationById(core.conversationId).catch(() => {
      // Conversation may have been deleted — ignore
    });
  }, [core.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Start a wiki operation — sends a natural-language message that triggers
   * the matching wiki-* skill (build/ingest/lint/save). The caller embeds any
   * trigger words / file path in `message`. `operationTypeRef` is UI-only
   * (panel badge); it no longer selects a backend prompt.
   */
  const startWikiOperation = useCallback(async (
    type: WikiOperationType,
    message: string,
  ) => {
    operationTypeRef.current = type;
    await core.send(message);
  }, [core.send]);

  const resetWithOpClear = useCallback(() => {
    operationTypeRef.current = null;
    core.reset();
  }, [core.reset]);

  return {
    messages: core.messages,
    runId: core.runId,
    isRunning: core.isRunning,
    conversationId: core.conversationId,
    send: core.send,
    submitToolResult: core.submitToolResult,
    cancel: core.cancel,
    reset: resetWithOpClear,
    loadConversation,
    loadConversationById,
    // Wiki mode fields
    operationType: operationTypeRef.current,
    startWikiOperation,
  };
}
