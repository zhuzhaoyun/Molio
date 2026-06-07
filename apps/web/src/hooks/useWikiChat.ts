/**
 * Wiki chat hook — manages agent conversation for wiki operations.
 *
 * Simplified version of useChat: no DB persistence, wiki-specific API calls.
 * Used by the KB page's WikiChatPanel for build/ingest/lint/query operations.
 */

import { useState, useCallback, useRef } from 'react';
import type { AgentEvent, WikiOperationType } from '@molio/contracts';
import { api } from '../api/client';
import { subscribeToRun } from '../api/sse';
import type { ChatMessage, ToolEvent } from './useChat';

interface WikiChatState {
  messages: ChatMessage[];
  runId: string | null;
  isRunning: boolean;
  operationType: WikiOperationType | null;
}

interface UseWikiChatOptions {
  vaultId: string | null;
  agentId: string | null;
  /** Called after a run completes successfully (e.g. to refresh the file tree). */
  onComplete?: () => void;
}

let msgCounter = 0;
function nextMsgId() { return `wiki-msg-${++msgCounter}-${Date.now()}`; }

export function useWikiChat(options: UseWikiChatOptions) {
  const { vaultId, agentId, onComplete } = options;

  const [state, setState] = useState<WikiChatState>({
    messages: [],
    runId: null,
    isRunning: false,
    operationType: null,
  });

  const esRef = useRef<EventSource | null>(null);
  const assistantIdRef = useRef<string | null>(null);

  const closeEventSource = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  /**
   * Start a wiki operation — creates a run with the appropriate API endpoint.
   */
  const startOperation = useCallback(async (
    type: WikiOperationType,
    message: string,
    extra?: { filePath?: string },
  ) => {
    if (!vaultId || !agentId) return;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    const assistantId = nextMsgId();
    assistantIdRef.current = assistantId;

    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      tools: [],
    };

    setState((prev) => ({
      messages: [...prev.messages, userMsg, assistantMsg],
      runId: null,
      isRunning: true,
      operationType: type,
    }));

    closeEventSource();

    try {
      let result: { runId: string };

      switch (type) {
        case 'build':
          result = await api.buildWiki(vaultId, { agentId });
          break;
        case 'ingest':
          result = await api.ingestFile(vaultId, { agentId, filePath: extra?.filePath ?? message });
          break;
        case 'lint':
          result = await api.lintWiki(vaultId, { agentId });
          break;
        case 'query':
          result = await api.queryWiki(vaultId, { agentId, message });
          break;
      }

      const runId = result.runId;
      setState((prev) => ({ ...prev, runId }));

      const es = subscribeToRun(
        runId,
        (event: AgentEvent) => {
          setState((prev) => updateWithEvent(prev, assistantId, event));
        },
        () => { /* SSE error — EventSource auto-retries */ },
      );

      esRef.current = es;

      // Listen for run completion via events
      const origOnEvent = es.onmessage;
      es.onmessage = (msg) => {
        origOnEvent?.call(es, msg);
        try {
          const envelope = JSON.parse(msg.data);
          const ev = envelope.event;
          if (ev.type === 'status' && (ev.label === 'completed' || ev.label === 'failed')) {
            if (ev.label === 'completed') {
              onComplete?.();
            }
          }
        } catch { /* ignore parse errors */ }
      };
    } catch (err) {
      setState((prev) => {
        const messages = prev.messages.map((msg) =>
          msg.id === assistantId
            ? { ...msg, content: `Error: ${(err as Error).message}`, streaming: false }
            : msg
        );
        return { ...prev, messages, isRunning: false };
      });
    }
  }, [vaultId, agentId, closeEventSource, onComplete]);

  /**
   * Send a follow-up message to the active run (multi-turn).
   */
  const send = useCallback(async (text: string) => {
    if (!text.trim()) return;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };

    const assistantId = nextMsgId();
    assistantIdRef.current = assistantId;

    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      tools: [],
    };

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMsg, assistantMsg],
      isRunning: true,
    }));

    // Try multi-turn on existing run
    if (state.runId) {
      try {
        await api.sendMessage(state.runId, text.trim());
        return;
      } catch {
        // Multi-turn failed — fall through to new query run
      }
    }

    // Fallback: create a new query run
    if (!vaultId || !agentId) return;

    closeEventSource();

    try {
      const result = await api.queryWiki(vaultId, { agentId, message: text.trim() });
      const runId = result.runId;
      setState((prev) => ({ ...prev, runId }));

      const es = subscribeToRun(
        runId,
        (event: AgentEvent) => {
          setState((prev) => updateWithEvent(prev, assistantId, event));
        },
        () => {},
      );
      esRef.current = es;
    } catch (err) {
      setState((prev) => {
        const messages = prev.messages.map((msg) =>
          msg.id === assistantId
            ? { ...msg, content: `Error: ${(err as Error).message}`, streaming: false }
            : msg
        );
        return { ...prev, messages, isRunning: false };
      });
    }
  }, [state.runId, vaultId, agentId, closeEventSource]);

  const submitToolResult = useCallback(async (toolUseId: string, content: string) => {
    if (!state.runId) return;
    await api.submitToolResult(state.runId, { toolUseId, content });

    setState((prev) => {
      const messages = prev.messages.map((msg) => {
        if (msg.tools) {
          const tools = msg.tools.map((t) =>
            t.id === toolUseId ? { ...t, result: content, status: 'done' as const } : t
          );
          return { ...msg, tools };
        }
        return msg;
      });
      return { ...prev, messages };
    });
  }, [state.runId]);

  const cancel = useCallback(async () => {
    if (state.runId) {
      await api.cancelRun(state.runId);
    }
    closeEventSource();
    assistantIdRef.current = null;

    setState((prev) => {
      const messages = prev.messages.map((msg) =>
        msg.streaming ? { ...msg, streaming: false } : msg
      );
      return { ...prev, messages, isRunning: false, runId: null };
    });
  }, [state.runId, closeEventSource]);

  const reset = useCallback(() => {
    closeEventSource();
    assistantIdRef.current = null;
    setState({ messages: [], runId: null, isRunning: false, operationType: null });
  }, [closeEventSource]);

  return {
    ...state,
    startOperation,
    send,
    submitToolResult,
    cancel,
    reset,
  };
}

/**
 * Update chat state based on SSE event — same logic as useChat's updateWithEvent.
 */
function updateWithEvent(
  prev: WikiChatState,
  assistantId: string,
  event: AgentEvent,
): WikiChatState {
  const messages = prev.messages.map((msg) => {
    if (msg.id !== assistantId) return msg;

    switch (event.type) {
      case 'text_delta':
        return { ...msg, content: msg.content + event.delta };

      case 'thinking_delta':
        return { ...msg, thinking: (msg.thinking ?? '') + event.delta };

      case 'tool_use':
        return {
          ...msg,
          tools: [
            ...(msg.tools ?? []),
            { id: event.id, name: event.name, input: event.input, status: 'running' as const },
          ],
        };

      case 'tool_result': {
        const tools = (msg.tools ?? []).map((t) =>
          t.id === event.toolUseId
            ? { ...t, result: event.content, isError: event.isError, status: (event.isError ? 'error' : 'done') as ToolEvent['status'] }
            : t
        );
        return { ...msg, tools };
      }

      case 'usage':
        return {
          ...msg,
          usage: {
            input: event.usage?.input_tokens,
            output: event.usage?.output_tokens,
            cost: event.costUsd,
          },
        };

      case 'turn_end':
        return { ...msg, streaming: false };

      case 'error':
        return { ...msg, content: msg.content + `\n\nError: ${event.message}`, streaming: false };

      default:
        return msg;
    }
  });

  let isRunning = prev.isRunning;
  let runId = prev.runId;
  if (event.type === 'status' && (event.label === 'completed' || event.label === 'failed')) {
    isRunning = false;
    runId = null;
    const finalized = messages.map((msg) =>
      msg.id === assistantId ? { ...msg, streaming: false } : msg
    );
    return { ...prev, messages: finalized, isRunning, runId };
  }

  return { ...prev, messages, isRunning, runId };
}
