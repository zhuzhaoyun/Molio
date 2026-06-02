import { useState, useCallback, useRef } from 'react';
import type { AgentEvent, ChatMessage as ContractsChatMessage } from '@kge/contracts';
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
  isRunning: boolean;
  conversationId: string | null;
}

interface UseChatOptions {
  agentId: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  initialMessages?: ChatMessage[];
}

let msgCounter = 0;
function nextMsgId() { return `msg-${++msgCounter}-${Date.now()}`; }

export function useChat(options: UseChatOptions | string | null) {
  // Support both old API (useChat(agentId)) and new API (useChat({ agentId, ... }))
  const agentId = typeof options === 'string' || options === null ? options : options.agentId;
  const projectId = typeof options === 'object' && options !== null ? options.projectId : null;
  const initialConversationId = typeof options === 'object' && options !== null ? options.conversationId : null;

  const [state, setState] = useState<ChatState>({
    messages: typeof options === 'object' && options !== null && options.initialMessages
      ? options.initialMessages
      : [],
    runId: null,
    isRunning: false,
    conversationId: initialConversationId ?? null,
  });
  const esRef = useRef<EventSource | null>(null);
  const assistantIdRef = useRef<string | null>(null);

  const closeEventSource = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  /**
   * Build history array from current messages for transcript building.
   */
  const buildHistory = useCallback((): ContractsChatMessage[] => {
    return state.messages
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
  }, [state.messages]);

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

    // Persist user message to DB if we have project/conversation
    if (projectId && state.conversationId) {
      try {
        await api.saveMessage(projectId, state.conversationId, {
          ...userMsg,
          role: 'user',
        } as ContractsChatMessage);
      } catch {
        // Persistence failure is non-fatal
      }
    }

    // Build history for transcript (all messages before this turn)
    const history = buildHistory();

    // Check if we can send to an existing run (multi-turn via stdin)
    const existingRunId = state.runId;

    if (existingRunId) {
      // Try multi-turn: send follow-up to existing run's stdin
      try {
        await api.sendMessage(existingRunId, text.trim());
        return; // Don't create new run/SSE — the existing one is still active
      } catch {
        // Multi-turn failed (run ended or stdin closed), fall through to new run
      }
    }

    // Create a new run with conversation history for transcript building
    closeEventSource();

    try {
      const result = await api.createRun({
        agentId,
        message: text.trim(),
        conversationId: state.conversationId ?? undefined,
        history: history.length > 0 ? history : undefined,
      });

      const runId = result.runId;
      const convId = result.conversationId ?? state.conversationId;

      setState((prev) => ({ ...prev, runId, conversationId: convId }));

      // Persist assistant placeholder
      if (projectId && convId) {
        try {
          await api.saveMessage(projectId, convId, {
            ...assistantMsg,
            role: 'assistant',
            runId,
            agentId,
          } as ContractsChatMessage);
        } catch {
          // Persistence failure is non-fatal
        }
      }

      const es = subscribeToRun(
        runId,
        (event: AgentEvent) => {
          setState((prev) => updateWithEvent(prev, assistantId, event));
        },
        () => { /* SSE error — EventSource auto-retries */ },
      );

      esRef.current = es;
    } catch (err) {
      // If run creation fails, mark the assistant message as error
      setState((prev) => {
        const messages = prev.messages.map((msg) =>
          msg.id === assistantId
            ? { ...msg, content: `Error: ${(err as Error).message}`, streaming: false }
            : msg
        );
        return { ...prev, messages, isRunning: false };
      });
    }
  }, [agentId, state.runId, state.conversationId, projectId, closeEventSource, buildHistory]);

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
    setState({ messages: [], runId: null, isRunning: false, conversationId: null });
  }, [closeEventSource]);

  const loadConversation = useCallback(async (
    projId: string,
    convId: string,
  ) => {
    closeEventSource();
    assistantIdRef.current = null;

    try {
      const messages = await api.listMessages(projId, convId);
      const chatMessages: ChatMessage[] = messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: m.timestamp,
        agentId: m.agentId,
        runId: m.runId,
        tools: m.tools as ToolEvent[] | undefined,
        usage: m.usage,
      }));

      setState({
        messages: chatMessages,
        runId: null,
        isRunning: false,
        conversationId: convId,
      });
    } catch (err) {
      console.error('Failed to load conversation:', err);
      setState({ messages: [], runId: null, isRunning: false, conversationId: convId });
    }
  }, [closeEventSource]);

  return {
    ...state,
    send,
    submitToolResult,
    cancel,
    reset,
    loadConversation,
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
