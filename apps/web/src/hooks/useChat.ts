import { useState, useCallback, useRef } from 'react';
import type { AgentEvent } from '@kge/contracts';
import { api } from '../api/client';
import { subscribeToRun } from '../api/sse';

export interface ToolEvent {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'done' | 'error';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: number;
  runId?: string;
  // Assistant-only fields
  thinking?: string;
  tools?: ToolEvent[];
  streaming?: boolean;
  usage?: { input?: number; output?: number; cost?: number };
}

interface ChatState {
  messages: ChatMessage[];
  runId: string | null;
  isRunning: boolean;
}

let msgCounter = 0;
function nextMsgId() { return `msg-${++msgCounter}-${Date.now()}`; }

export function useChat(agentId: string | null) {
  const [state, setState] = useState<ChatState>({
    messages: [],
    runId: null,
    isRunning: false,
  });
  const esRef = useRef<EventSource | null>(null);
  const assistantIdRef = useRef<string | null>(null);

  const closeEventSource = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const send = useCallback(async (text: string) => {
    if (!agentId || !text.trim()) return;

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

    // Check if we can send to an existing run (multi-turn)
    const existingRunId = state.runId;
    let runId: string;

    if (existingRunId) {
      // Try multi-turn: send follow-up to existing run
      try {
        await api.sendMessage(existingRunId, text.trim());
        runId = existingRunId;
        // Don't create new SSE — the existing one is still active
        return;
      } catch {
        // Multi-turn failed (run ended), fall through to new run
      }
    }

    // Create a new run
    closeEventSource();
    runId = await api.createRun({ agentId, message: text.trim() });

    setState((prev) => ({ ...prev, runId }));

    const es = subscribeToRun(
      runId,
      (event: AgentEvent) => {
        setState((prev) => updateWithEvent(prev, assistantId, event));
      },
      () => { /* SSE error — EventSource auto-retries */ },
    );

    esRef.current = es;
  }, [agentId, state.runId, closeEventSource]);

  const submitToolResult = useCallback(async (toolUseId: string, content: string) => {
    if (!state.runId) return;
    await api.submitToolResult(state.runId, { toolUseId, content });

    // Update the tool card status
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
    setState({ messages: [], runId: null, isRunning: false });
  }, [closeEventSource]);

  return {
    ...state,
    send,
    submitToolResult,
    cancel,
    reset,
  };
}

function updateWithEvent(
  prev: ChatState,
  assistantId: string,
  event: AgentEvent,
): ChatState {
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

  // Check if run ended (status completed/failed)
  let isRunning = prev.isRunning;
  let runId = prev.runId;
  if (event.type === 'status' && (event.label === 'completed' || event.label === 'failed')) {
    isRunning = false;
    runId = null;
    // Finalize the streaming assistant message
    const finalized = messages.map((msg) =>
      msg.id === assistantId ? { ...msg, streaming: false } : msg
    );
    return { ...prev, messages: finalized, isRunning, runId };
  }

  return { ...prev, messages, isRunning, runId };
}
