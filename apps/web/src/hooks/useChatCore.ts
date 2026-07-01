/**
 * useChatCore — shared chat logic for all chat-based UIs.
 *
 * Handles SSE subscription, event processing, message state, multi-turn,
 * cancel, tool result submission, and reset.
 *
 * Callers provide a `createRun` function to decide which API endpoint to call.
 */

import { useState, useCallback, useRef } from 'react';
import type { AgentEvent } from '@molio/contracts';
import { api } from '../api/client';
import { subscribeToRun } from '../api/sse';
import { ACP_MODELS_UPDATED_EVENT, type AcpModelsUpdatedDetail } from './useAgents';

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
  agentId?: string;
  // Assistant-only fields
  thinking?: string;
  tools?: ToolEvent[];
  streaming?: boolean;
  usage?: { input?: number; output?: number; cost?: number };
}

interface ChatState {
  messages: ChatMessage[];
  runId: string | null;
  /** Agent that created the current run — used to detect runtime switches. */
  runAgentId: string | null;
  isRunning: boolean;
  conversationId: string | null;
}

export interface RunResult {
  runId: string;
  conversationId?: string;
}

export interface CreateRunContext {
  message: string;
  history: ChatMessage[];
  conversationId: string | null;
}

export interface UseChatCoreOptions {
  /** Called to create a new run. Implementations decide which API to call. */
  createRun: (ctx: CreateRunContext) => Promise<RunResult>;
  /** Current agent ID — used to detect runtime switches and invalidate stale runs. */
  agentId?: string | null;
  /** Initial messages to pre-populate (e.g. from DB). */
  initialMessages?: ChatMessage[];
  /** Initial conversation ID. */
  initialConversationId?: string | null;
  /** Called when a run completes successfully. */
  onComplete?: () => void;
}

let msgCounter = 0;
function nextMsgId() { return `msg-${++msgCounter}-${Date.now()}`; }

export function useChatCore(options: UseChatCoreOptions) {
  const { createRun, agentId, initialMessages = [], initialConversationId = null, onComplete } = options;

  const [state, setState] = useState<ChatState>({
    messages: initialMessages,
    runId: null,
    runAgentId: null,
    isRunning: false,
    conversationId: initialConversationId,
  });

  const esRef = useRef<EventSource | null>(null);
  const assistantIdRef = useRef<string | null>(null);

  const closeEventSource = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  /**
   * Send a message — tries multi-turn on existing run first, falls back to createRun.
   */
  const send = useCallback(async (text: string) => {
    if (!text.trim()) return;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };

    const newAssistantId = nextMsgId();
    assistantIdRef.current = newAssistantId;

    const assistantMsg: ChatMessage = {
      id: newAssistantId,
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

    // Try multi-turn on existing run — but only if the agent hasn't changed.
    // When the user switches runtime (e.g. Claude → Qwen), the existing run
    // belongs to the old agent; sending a follow-up would go to the wrong process.
    const existingRunId = state.runId;
    const agentChanged = agentId != null && state.runAgentId != null && agentId !== state.runAgentId;
    if (existingRunId && !agentChanged) {
      try {
        await api.sendMessage(existingRunId, text.trim());
        return; // SSE is still active, events route via assistantIdRef
      } catch {
        // Multi-turn failed — fall through to new run
      }
    }

    // Build history for transcript
    const history = state.messages
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

    closeEventSource();

    // If the agent changed, cancel the old run so its process doesn't linger
    if (agentChanged && existingRunId) {
      api.cancelRun(existingRunId).catch(() => {});
    }

    try {
      const result = await createRun({
        message: text.trim(),
        history,
        conversationId: state.conversationId,
      });

      const runId = result.runId;
      const convId = result.conversationId ?? state.conversationId;

      setState((prev) => ({ ...prev, runId, runAgentId: agentId ?? null, conversationId: convId }));

      const es = subscribeToRun(
        runId,
        (event: AgentEvent) => {
          const currentId = assistantIdRef.current;
          if (!currentId) return;
          // ACP agents (Hermes) report their real model list via session/new.
          // Fan out to useAgents so the model picker updates dynamically.
          if (event.type === 'models' && agentId) {
            const detail: AcpModelsUpdatedDetail = {
              agentId,
              models: event.models,
              currentModelId: event.currentModelId,
            };
            window.dispatchEvent(new CustomEvent(ACP_MODELS_UPDATED_EVENT, { detail }));
          }
          setState((prev) => updateWithEvent(prev, currentId, event));
        },
        () => { /* SSE error — EventSource auto-retries */ },
      );

      esRef.current = es;

      // Listen for completion to trigger onComplete callback
      if (onComplete) {
        const origOnEvent = es.onmessage;
        es.onmessage = (msg) => {
          origOnEvent?.call(es, msg);
          try {
            const envelope = JSON.parse(msg.data);
            const ev = envelope.event;
            if (ev.type === 'status' && ev.label === 'completed') {
              onComplete();
            }
          } catch { /* ignore parse errors */ }
        };
      }
    } catch (err) {
      const errId = newAssistantId;
      setState((prev) => {
        const messages = prev.messages.map((msg) =>
          msg.id === errId
            ? { ...msg, content: `Error: ${(err as Error).message}`, streaming: false }
            : msg
        );
        return { ...prev, messages, isRunning: false };
      });
    }
  }, [state.runId, state.runAgentId, state.conversationId, state.messages, closeEventSource, createRun, agentId, onComplete]);

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
      return { ...prev, messages, isRunning: false, runId: null, runAgentId: null };
    });
  }, [state.runId, closeEventSource]);

  const reset = useCallback(() => {
    closeEventSource();
    assistantIdRef.current = null;
    setState({ messages: [], runId: null, runAgentId: null, isRunning: false, conversationId: null });
  }, [closeEventSource]);

  /**
   * Replace messages and conversationId (used by loadConversation in useChat).
   */
  const setMessages = useCallback((messages: ChatMessage[], conversationId?: string | null) => {
    closeEventSource();
    assistantIdRef.current = null;
    setState({
      messages,
      runId: null,
      runAgentId: null,
      isRunning: false,
      conversationId: conversationId ?? null,
    });
  }, [closeEventSource]);

  return {
    ...state,
    send,
    submitToolResult,
    cancel,
    reset,
    setMessages,
  };
}

/**
 * Apply an SSE event to the chat state.
 *
 * Key behaviors for multi-turn agents (Claude Code with stream-json stdin):
 *  - The child process stays alive between turns (stdin stays open).
 *  - `turn_end` with stopReason !== 'tool_use' means the agent finished
 *    answering this turn → re-enable input, mark message as done.
 *  - `turn_end` with stopReason === 'tool_use' means the agent paused for
 *    tool execution → keep streaming, keep input locked.
 *  - `usage` always arrives after a turn completes → also re-enables input
 *    (serves as a fallback signal).
 *  - `status: completed/failed` means the child process exited → clear runId.
 */
function updateWithEvent(
  prev: ChatState,
  assistantId: string,
  event: AgentEvent,
): ChatState {
  const messages = prev.messages.map((msg) => {
    if (msg.id !== assistantId) return msg;

    switch (event.type) {
      case 'text_delta':
        if (!msg.streaming) return msg;
        return { ...msg, content: msg.content + event.delta };

      case 'thinking_delta':
        if (!msg.streaming) return msg;
        return { ...msg, thinking: (msg.thinking ?? '') + event.delta };

      case 'tool_use':
        if (!msg.streaming) return msg;
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
        if (event.stopReason === 'tool_use') return msg;
        return { ...msg, streaming: false };

      case 'error':
        return { ...msg, content: msg.content + `\n\nError: ${event.message}`, streaming: false };

      default:
        return msg;
    }
  });

  let isRunning = prev.isRunning;
  let runId = prev.runId;

  if (event.type === 'turn_end' && event.stopReason !== 'tool_use') {
    isRunning = false;
  }

  if (event.type === 'usage') {
    isRunning = false;
  }

  if (event.type === 'status' && (event.label === 'completed' || event.label === 'failed')) {
    isRunning = false;
    runId = null;
    const finalized = messages.map((msg) =>
      msg.id === assistantId ? { ...msg, streaming: false } : msg
    );
    return { ...prev, messages: finalized, isRunning, runId, runAgentId: null };
  }

  return { ...prev, messages, isRunning, runId };
}
