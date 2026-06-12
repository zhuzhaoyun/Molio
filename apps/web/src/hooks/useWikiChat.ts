/**
 * useWikiChat — wiki operation hook.
 *
 * Wraps useChatCore with:
 *  - Wiki-specific API endpoints (build/ingest/lint/query/save)
 *  - startOperation() for triggering wiki operations
 *  - onComplete callback for refreshing the file tree
 *  - send() defaults to queryWiki for follow-up messages
 */

import { useRef, useCallback } from 'react';
import type { WikiOperationType } from '@molio/contracts';
import { api } from '../api/client';
import { useChatCore } from './useChatCore';

export type { ChatMessage, ToolEvent } from './useChatCore';

interface UseWikiChatOptions {
  vaultId: string | null;
  agentId: string | null;
  /** Called after a run completes successfully (e.g. to refresh the file tree). */
  onComplete?: () => void;
}

export function useWikiChat(options: UseWikiChatOptions) {
  const { vaultId, agentId, onComplete } = options;
  const operationTypeRef = useRef<WikiOperationType | null>(null);

  const core = useChatCore({
    agentId,
    onComplete,
    createRun: async ({ message, operationType, extra }) => {
      if (!vaultId || !agentId) throw new Error('No vault or agent selected');

      switch (operationType as WikiOperationType) {
        case 'build':
          return api.buildWiki(vaultId, { agentId });
        case 'ingest':
          return api.ingestFile(vaultId, { agentId, filePath: (extra?.filePath as string) ?? message });
        case 'lint':
          return api.lintWiki(vaultId, { agentId });
        case 'query':
          return api.queryWiki(vaultId, { agentId, message });
        case 'save':
          return api.saveWiki(vaultId, { agentId, message });
        default:
          // Default to query for plain send() calls
          return api.queryWiki(vaultId, { agentId, message });
      }
    },
  });

  /**
   * Start a wiki operation — creates a run with the appropriate API endpoint.
   */
  const startOperation = useCallback(async (
    type: WikiOperationType,
    message: string,
    extra?: { filePath?: string },
  ) => {
    operationTypeRef.current = type;
    await core.send(message, {
      operationType: type,
      extra: extra as Record<string, unknown>,
    });
  }, [core.send]);

  const reset = useCallback(() => {
    operationTypeRef.current = null;
    core.reset();
  }, [core.reset]);

  return {
    messages: core.messages,
    runId: core.runId,
    isRunning: core.isRunning,
    operationType: operationTypeRef.current,
    startOperation,
    send: core.send,
    submitToolResult: core.submitToolResult,
    cancel: core.cancel,
    reset,
  };
}
