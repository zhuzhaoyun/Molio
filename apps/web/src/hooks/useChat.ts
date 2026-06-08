import { useState, useCallback, useRef } from 'react';
import type { AgentEvent, ChatMessage as ContractsChatMessage } from '@molio/contracts';
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
  cwd?: string | null;
}

let msgCounter = 0;
function nextMsgId() { return `msg-${++msgCounter}-${Date.now()}`; }

export function useChat(options: UseChatOptions | string | null) {
  // Support both old API (useChat(agentId)) and new API (useChat({ agentId, ... }))
  const agentId = typeof options === 'string' || options === null ? options : options.agentId;
  const projectId = typeof options === 'object' && options !== null ? options.projectId : null;
  const initialConversationId = typeof options === 'object' && options !== null ? options.conversationId : null;
  const cwd = typeof options === 'object' && options !== null ? options.cwd : null;

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

    // Check if we can send to an existing run (multi-turn via stdin).
    // For multi-turn agents (e.g. Claude Code), the process stays alive
    // between turns, so follow-up messages go to the same stdin.
    const existingRunId = state.runId;

    if (existingRunId) {
      try {
        await api.sendMessage(existingRunId, text.trim());
        return; // SSE is still active, events route via assistantIdRef
      } catch {
        // Multi-turn failed (run ended or stdin closed), fall through to new run
      }
    }

    // Build history for transcript (all messages before this turn)
    const history = buildHistory();

    // Create a new run with conversation history for transcript building
    closeEventSource();

    try {
      const result = await api.createRun({
        agentId,
        message: text.trim(),
        conversationId: state.conversationId ?? undefined,
        history: history.length > 0 ? history : undefined,
        cwd: cwd ?? undefined,
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
          // Read ref at event time, not closure time. This is critical
          // for multi-turn: when send() is called again, it updates
          // assistantIdRef before sendMessage(), so subsequent SSE events
          // route to the new assistant message.
          const currentId = assistantIdRef.current;
          if (!currentId) return;
          setState((prev) => updateWithEvent(prev, currentId, event));
        },
        () => { /* SSE error — EventSource auto-retries */ },
      );

      esRef.current = es;
    } catch (err) {
      // If run creation fails, mark the assistant message as error
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
  }, [agentId, state.runId, state.conversationId, projectId, cwd, closeEventSource, buildHistory]);

  const submitToolResult = useCallback(async (toolUseId: string, content: string) => {
    if (!state.runId) return;
    await api.submitToolResult(state.runId, { toolUseId, content });

    // Update the tool card status in whichever assistant message owns it
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
 *    For multi-turn agents this only happens on cancel.
 */
function updateWithEvent(
  prev: ChatState,
  assistantId: string,
  event: AgentEvent,
): ChatState {
  // Update the target assistant message's content/tools/status.
  // Guard: if the message already has streaming: false (turn completed),
  // ignore content-type events to prevent idle chatter from being appended.
  const messages = prev.messages.map((msg) => {
    if (msg.id !== assistantId) return msg;

    switch (event.type) {
      case 'text_delta':
        // Skip if this message already finished (prevents idle chatter)
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
        // Only mark as done when the agent actually finished answering.
        // 'tool_use' means it paused for tool execution, not done yet.
        if (event.stopReason === 'tool_use') return msg;
        return { ...msg, streaming: false };

      case 'error':
        return { ...msg, content: msg.content + `\n\nError: ${event.message}`, streaming: false };

      default:
        return msg;
    }
  });

  // Determine isRunning and runId based on the event.
  let isRunning = prev.isRunning;
  let runId = prev.runId;

  // Signal 1: turn_end with non-tool_use stopReason → agent finished this turn
  if (event.type === 'turn_end' && event.stopReason !== 'tool_use') {
    isRunning = false;
  }

  // Signal 2: usage → always emitted after a turn completes (fallback)
  if (event.type === 'usage') {
    isRunning = false;
  }

  // Signal 3: process exited → run is truly over, clear runId.
  // For multi-turn agents this only fires on cancelRun() or process crash.
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
