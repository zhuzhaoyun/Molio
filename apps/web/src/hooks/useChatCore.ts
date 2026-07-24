/**
 * useChatCore — shared chat logic for all chat-based UIs.
 *
 * Handles SSE subscription, event processing, message state, multi-turn,
 * cancel, tool result submission, reset, and rewind-resend.
 *
 * Callers provide a `createRun` function to decide which API endpoint to call
 * and an optional `rewindResend` for regenerating/editing the last user turn.
 */

import { useState, useCallback, useRef } from 'react';
import type { AgentEvent, ActivityInfo } from '@molio/contracts';
import { api } from '../api/client';
import { subscribeToRun } from '../api/sse';
import { ACP_MODELS_UPDATED_EVENT, type AcpModelsUpdatedDetail } from './useAgents';
import { messageSelectionStore } from '../stores/messageSelectionStore';

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
  /** Transient repair status (hermes [acp] extra auto-install). Cleared on
   *  first real content (text/thinking/tool) or any terminal state. */
  repairing?: string;
  /** Error from the agent or run lifecycle (ACP timeout, spawn failure, etc).
   *  Kept separate from `content` so saved messages don't carry an "Error:"
   *  prefix — the UI renders this as a distinct banner above the prose. */
  error?: string;
}

interface ChatState {
  messages: ChatMessage[];
  runId: string | null;
  /** Agent that created the current run — used to detect runtime switches. */
  runAgentId: string | null;
  isRunning: boolean;
  conversationId: string | null;
  /**
   * Live background subagent/workflow activity (daemon transcript watcher).
   * Independent of isRunning: after turn_end the input unlocks while a
   * Workflow keeps running — this is what keeps the UI alive in that gap.
   */
  activity: ActivityInfo | null;
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
  /** Called to rewind a conversation to its last user message and start a fresh run. */
  rewindResend?: (ctx: { conversationId: string; newContent: string }) => Promise<RunResult>;
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

/**
 * Idle window for the fallback unlock timer. Long enough to tolerate a single
 * silent long-running tool call (e.g. remotion `npm install` of a large dep
 * tree on a slow network) without a false "响应超时"; short enough that a
 * genuinely hung run (daemon alive but no events) still surfaces in ~10min.
 * The timer is idle-based — reset on every received event — so an ACTIVE run
 * of any length never false-times-out.
 */
const FALLBACK_IDLE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Watchdog: if no SSE frame (event OR ping) arrives for this long, the
 * connection is presumed dead. The 11.5-min abort bug leaves EventSource at
 * readyState=OPEN but silent — onerror/onDone never fire. The watchdog then
 * reconnects to the SAME run with ?after=<lastSeq> so daemon replays missed
 * events (session/cache preserved, no createRun). 45s = 3× the 15s ping; only
 * a truly dead connection (3 missed pings) trips it. Backoff per attempt;
 * MAX_RECONNECT caps it, after which onDone fires (→ createRun next time).
 *
 * Test hook: `window.__MOLIO_TEST_WATCHDOG_MS__` shortens the wait for E2E.
 */
const WATCHDOG_MS = 45_000;
const MAX_RECONNECT = 4;

export function useChatCore(options: UseChatCoreOptions) {
  const { createRun, rewindResend, agentId, initialMessages = [], initialConversationId = null, onComplete } = options;

  const [state, setState] = useState<ChatState>({
    messages: initialMessages,
    runId: null,
    runAgentId: null,
    isRunning: false,
    conversationId: initialConversationId,
    activity: null,
  });

  const esRef = useRef<EventSource | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  // P2-3: fallback timer that force-unlocks the input if the daemon hangs or
  // the SSE dies without a terminal event. Aligned with daemon's
  // promptIdleTimeoutMs (5min) — if no terminal status arrives by then, the
  // user gets the input back instead of a permanently locked composer.
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last received SSE seq — used as ?after= when the watchdog reconnects, so
  // daemon replays only the events missed during the dead connection.
  const lastSeqRef = useRef<number>(0);
  // Watchdog timer — fires when no frame (event or ping) arrives for WATCHDOG_MS.
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scheduled reconnect (exponential backoff). Cleared on clean shutdown so a
  // pending reconnect doesn't fire after cancel/reset.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reconnect attempt counter for exponential backoff + cap.
  const reconnectAttemptRef = useRef<number>(0);
  // The watchdog invokes this to reconnect; set inside beginNewRun so it
  // closures the current run's callbacks + runId. Null when no active run.
  const reconnectRef = useRef<(() => void) | null>(null);
  // True while doReconnect is swapping the EventSource — onDoneCb from the OLD
  // es (fired by its close()) must be ignored so it doesn't clear runId/isRunning
  // mid-swap. Only the NEW es's onDone (or a genuine daemon exit) should unlock.
  const reconnectingRef = useRef<boolean>(false);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Re-arm the watchdog (clear + schedule). On timeout, invokes reconnectRef
   * (set by beginNewRun) to re-subscribe to the SAME run with ?after=<lastSeq>.
   * Called on every received event and every ping frame.
   */
  const armWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
    }
    const wdMs = (typeof window !== 'undefined' &&
      (window as any).__MOLIO_TEST_WATCHDOG_MS__) || WATCHDOG_MS;
    watchdogTimerRef.current = setTimeout(() => {
      const cb = reconnectRef.current;
      if (!cb) return;
      cb();
    }, wdMs);
  }, []);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  /**
   * Re-arm the idle fallback timer (clear + schedule). Called on every
   * received AgentEvent so a long but active run never false-times-out; the
   * timer only fires when the stream goes truly silent for FALLBACK_IDLE_MS.
   * Terminal status clears (does not re-arm) via clearFallbackTimer.
   */
  const resetFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
    }
    const fallbackMs = (typeof window !== 'undefined' &&
      (window as any).__MOLIO_TEST_FALLBACK_TIMEOUT_MS__) || FALLBACK_IDLE_MS;
    fallbackTimerRef.current = setTimeout(() => {
      console.warn('[chat] idle fallback fired after ' + fallbackMs + 'ms — no SSE events received; force-unlocking. assistantId=' + (assistantIdRef.current ?? '(empty)'));
      setState((prev) => {
        if (!prev.isRunning) {
          console.debug('[chat] idle fallback noop — no longer running');
          return prev;
        }
        const messages = prev.messages.map((msg) =>
          msg.id === assistantIdRef.current && msg.streaming
            ? { ...msg, streaming: false, error: msg.error ?? '响应超时，请重试或检查 daemon 是否运行' }
            : msg
        );
        return { ...prev, messages, isRunning: false, runId: null, runAgentId: null };
      });
      esRef.current?.close();
      esRef.current = null;
    }, fallbackMs);
  }, []);

  const closeEventSource = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    clearFallbackTimer();
    clearWatchdog();
    reconnectRef.current = null;
  }, [clearFallbackTimer, clearWatchdog]);

  const beginNewRun = useCallback(async (
    result: RunResult,
    assistantId: string,
    optimisticMessages: ChatMessage[],
  ) => {
    const runId = result.runId;
    const convId = result.conversationId ?? state.conversationId;

    // The passed assistantId is the initial SSE event target. We set the ref
    // here (instead of relying solely on callers) so the parameter is
    // actually used and callers don't need an implicit set-ref-first contract.
    // The ref — not the parameter — is read inside the callback so the
    // multi-turn path (api.sendMessage on an existing run) can retarget
    // events to a new assistant message without resubscribing.
    assistantIdRef.current = assistantId;
    clearFallbackTimer();
    clearWatchdog();
    reconnectAttemptRef.current = 0;
    lastSeqRef.current = 0;

    setState((prev) => ({
      ...prev,
      messages: optimisticMessages,
      runId,
      runAgentId: agentId ?? null,
      conversationId: convId,
      isRunning: true,
      activity: null,
    }));

    // --- SSE callbacks (named so the watchdog can re-subscribe with the same
    // callbacks + ?after=<lastSeq> on reconnect) ---
    const onEventCb = (event: AgentEvent, seq?: number) => {
      const currentId = assistantIdRef.current;
      console.debug('[chat] event type=' + event.type + ' runId=' + runId + ' assistantId=' + (currentId ?? '(empty)'));
      if (seq && seq > (lastSeqRef.current || 0)) lastSeqRef.current = seq;
      // Any frame (event or ping) = connection alive: reset backoff + watchdog.
      reconnectAttemptRef.current = 0;
      armWatchdog();
      if (!currentId) {
        console.warn('[chat] event DROPPED — assistantIdRef empty, cannot route. type=' + event.type);
        return;
      }
      if (event.type === 'models' && agentId) {
        const detail: AcpModelsUpdatedDetail = {
          agentId,
          models: event.models,
          currentModelId: event.currentModelId,
        };
        window.dispatchEvent(new CustomEvent(ACP_MODELS_UPDATED_EVENT, { detail }));
      }
      setState((prev) => updateWithEvent(prev, currentId, event));
      if (event.type === 'status' && (event.label === 'completed' || event.label === 'failed' || event.label === 'canceled')) {
        clearFallbackTimer();
      } else {
        resetFallbackTimer();
      }
    };
    const onDoneCb = () => {
      // During watchdog reconnect, closing the OLD es fires its onDone here —
      // ignore it so we don't clear runId/isRunning mid-swap. Only the NEW es's
      // onDone (or a genuine daemon exit) should unlock.
      if (reconnectingRef.current) return;
      console.warn('[chat] SSE onDone (CLOSED) — force-unlocking. runId=' + runId);
      clearWatchdog();
      reconnectRef.current = null;
      setState((prev) => {
        if (!prev.isRunning) return prev;
        const messages = prev.messages.map((msg) =>
          msg.streaming ? { ...msg, streaming: false } : msg
        );
        return { ...prev, messages, isRunning: false, runId: null, runAgentId: null, activity: null };
      });
      clearFallbackTimer();
    };
    const onKeepaliveCb = () => {
      // ping frame — connection alive. Same reset as a real event.
      reconnectAttemptRef.current = 0;
      armWatchdog();
    };

    const es = subscribeToRun(runId, onEventCb, undefined, onDoneCb, undefined, onKeepaliveCb);
    esRef.current = es;

    // Idle fallback (10min) + watchdog (45s). The watchdog fires first on a
    // dead-but-OPEN connection and reconnects to the same run; the idle fallback
    // is the older safety net for genuinely hung runs. Both re-armed per frame.
    armWatchdog();
    resetFallbackTimer();

    if (onComplete) {
      const origOnEvent = es.onmessage;
      es.onmessage = (msg) => {
        origOnEvent?.call(es, msg);
        try {
          const envelope = JSON.parse(msg.data);
          const ev = envelope.event;
          if (ev.type === 'status' && ev.label === 'completed') onComplete();
        } catch { /* ignore parse errors */ }
      };
    }

    // Watchdog reconnect: re-subscribe to the SAME run with ?after=<lastSeq>
    // so daemon replays missed events (session/cache preserved, no createRun).
    // Closures the named callbacks above; reassigned every beginNewRun so it
    // always reflects the current run's wiring. Exponential backoff per attempt;
    // after MAX_RECONNECT, fall through to onDone (next send → createRun).
    const doReconnect = (afterSeq: number) => {
      // Guard: closing the old es fires its onDone — onDoneCb checks this flag
      // and skips. Reset only after the NEW es is wired.
      reconnectingRef.current = true;
      esRef.current?.close();
      esRef.current = null;
      clearFallbackTimer();
      clearWatchdog();
      const newEs = subscribeToRun(runId, onEventCb, undefined, onDoneCb, afterSeq, onKeepaliveCb);
      esRef.current = newEs;
      armWatchdog();
      resetFallbackTimer();
      if (onComplete) {
        const orig = newEs.onmessage;
        newEs.onmessage = (msg) => {
          orig?.call(newEs, msg);
          try {
            const envelope = JSON.parse(msg.data);
            const ev = envelope.event;
            if (ev.type === 'status' && ev.label === 'completed') onComplete();
          } catch { /* ignore */ }
        };
      }
      console.warn('[sse] watchdog reconnected runId=' + runId + ' afterSeq=' + afterSeq);
      reconnectingRef.current = false;
    };
    reconnectRef.current = () => {
      reconnectAttemptRef.current += 1;
      const attempt = reconnectAttemptRef.current;
      const wdMs = (typeof window !== 'undefined' &&
        (window as any).__MOLIO_TEST_WATCHDOG_MS__) || WATCHDOG_MS;
      if (attempt > MAX_RECONNECT) {
        console.warn('[sse] watchdog gave up after ' + MAX_RECONNECT + ' reconnects — onDone (next send → createRun)');
        reconnectRef.current = null;
        onDoneCb();
        return;
      }
      const delay = wdMs * 2 ** (attempt - 1);
      console.warn('[sse] watchdog no frames for ' + wdMs + 'ms, reconnect attempt ' + attempt + ' in ' + delay + 'ms');
      reconnectTimerRef.current = setTimeout(() => doReconnect(lastSeqRef.current), delay);
    };
  }, [state.conversationId, agentId, onComplete, clearFallbackTimer, clearWatchdog, armWatchdog, resetFallbackTimer]);

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

    const prevMessages = state.messages;

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
        // Multi-turn reuses the existing SSE subscription, which does NOT
        // re-arm the fallback timer (beginNewRun isn't called). Re-arm here so
        // a hung follow-up turn still force-unlocks instead of spinning
        // forever. Events from this turn keep resetting it (idle semantics).
        resetFallbackTimer();
        return; // SSE is still active, events route via assistantIdRef
      } catch {
        // Multi-turn failed — fall through to new run
      }
    }

    // Build history for transcript
    const history = prevMessages
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

      await beginNewRun(result, newAssistantId, [...prevMessages, userMsg, assistantMsg]);
    } catch (err) {
      const errId = newAssistantId;
      setState((prev) => {
        const messages = prev.messages.map((msg) =>
          msg.id === errId
            ? { ...msg, error: (err as Error).message, streaming: false }
            : msg
        );
        return { ...prev, messages, isRunning: false };
      });
    }
  }, [state.runId, state.runAgentId, state.conversationId, state.messages, closeEventSource, createRun, agentId, onComplete, beginNewRun, resetFallbackTimer]);

  const rewindAndResend = useCallback(async (newContent: string) => {
    if (!rewindResend) return;
    const convId = state.conversationId;
    if (!convId) return;

    // Find the last user message to build the optimistic truncated view.
    const lastUserIdx = (() => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i]!.role === 'user') return i;
      }
      return -1;
    })();
    if (lastUserIdx < 0) return;

    const prevMessages = state.messages.slice(0, lastUserIdx); // everything before last user msg
    const newUserMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'user',
      content: newContent.trim(),
      timestamp: Date.now(),
    };
    const newAssistantId = nextMsgId();
    assistantIdRef.current = newAssistantId;
    const newAssistantMsg: ChatMessage = {
      id: newAssistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      tools: [],
    };

    closeEventSource();

    try {
      const result = await rewindResend({ conversationId: convId, newContent: newContent.trim() });
      await beginNewRun(result, newAssistantId, [...prevMessages, newUserMsg, newAssistantMsg]);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, {
          id: nextMsgId(),
          role: 'error',
          content: `Error: ${(err as Error).message}`,
          timestamp: Date.now(),
        } as ChatMessage],
        isRunning: false,
      }));
    }
  }, [rewindResend, state.conversationId, state.messages, closeEventSource, beginNewRun]);

  const regenerateLast = useCallback(async () => {
    // Reuse the last user message's content verbatim.
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    await rewindAndResend(lastUser.content);
  }, [state.messages, rewindAndResend]);

  const editAndResend = useCallback(async (messageId: string, newContent: string) => {
    // Only the last user message is editable; guard against stale ids.
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || lastUser.id !== messageId) return;
    await rewindAndResend(newContent);
  }, [state.messages, rewindAndResend]);

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
      return { ...prev, messages, isRunning: false, runId: null, runAgentId: null, activity: null };
    });
  }, [state.runId, closeEventSource]);

  const reset = useCallback(() => {
    closeEventSource();
    assistantIdRef.current = null;
    messageSelectionStore.exit();
    setState({ messages: [], runId: null, runAgentId: null, isRunning: false, conversationId: null, activity: null });
  }, [closeEventSource]);

  /**
   * Replace messages and conversationId (used by loadConversation in useChat).
   */
  const setMessages = useCallback((messages: ChatMessage[], conversationId?: string | null) => {
    closeEventSource();
    assistantIdRef.current = null;
    messageSelectionStore.exit();
    setState({
      messages,
      runId: null,
      runAgentId: null,
      isRunning: false,
      conversationId: conversationId ?? null,
      activity: null,
    });
  }, [closeEventSource]);

  const deleteMessages = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const convId = state.conversationId;
    if (!convId) return;
    try {
      await api.deleteMessages(convId, ids);
      setState((prev) => ({
        ...prev,
        messages: prev.messages.filter((m) => !ids.includes(m.id)),
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: `err-${Date.now()}`,
            role: 'error' as const,
            content: `删除失败: ${(err as Error).message}`,
            timestamp: Date.now(),
          },
        ],
      }));
    }
  }, [state.conversationId]);

  return {
    ...state,
    send,
    submitToolResult,
    cancel,
    reset,
    setMessages,
    regenerateLast,
    editAndResend,
    deleteMessages,
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
/**
 * Clear the transient repairing status. Called by every case in updateWithEvent
 * that delivers real content (text/thinking/tool) or reaches a terminal state,
 * so the repairing spinner never lingers past the phase it represents.
 */
function clearRepairing(msg: ChatMessage): ChatMessage {
  return msg.repairing === undefined ? msg : { ...msg, repairing: undefined };
}

function updateWithEvent(
  prev: ChatState,
  assistantId: string,
  event: AgentEvent,
): ChatState {
  // Run-level event — no message routing needed.
  if (event.type === 'activity') {
    return { ...prev, activity: event.activity };
  }

  const messages = prev.messages.map((msg) => {
    if (msg.id !== assistantId) return msg;

    switch (event.type) {
      case 'text_delta':
        if (!msg.streaming) return msg;
        // First real content arrives — the repair phase is done, drop the
        // transient status line so it doesn't linger in the saved message.
        return clearRepairing({ ...msg, content: msg.content + event.delta });

      case 'thinking_delta':
        if (!msg.streaming) return msg;
        return clearRepairing({ ...msg, thinking: (msg.thinking ?? '') + event.delta });

      case 'repairing':
        // Hermes [acp] extra auto-install status. Transient — cleared once
        // real content (text_delta / thinking_delta) starts arriving, or on
        // any terminal state (error/turn_end/usage) via clearRepairing.
        if (!msg.streaming) return msg;
        return { ...msg, repairing: event.message };

      case 'tool_use':
        if (!msg.streaming) return msg;
        return clearRepairing({
          ...msg,
          tools: [
            ...(msg.tools ?? []),
            { id: event.id, name: event.name, input: event.input, status: 'running' as const },
          ],
        });

      case 'tool_result': {
        const tools = (msg.tools ?? []).map((t) =>
          t.id === event.toolUseId
            ? { ...t, result: event.content, isError: event.isError, status: (event.isError ? 'error' : 'done') as ToolEvent['status'] }
            : t
        );
        return clearRepairing({ ...msg, tools });
      }

      case 'usage':
        return clearRepairing({
          ...msg,
          usage: {
            input: event.usage?.input_tokens,
            output: event.usage?.output_tokens,
            cost: event.costUsd,
          },
        });

      case 'turn_end':
        if (event.stopReason === 'tool_use') return msg;
        return clearRepairing({ ...msg, streaming: false });

      case 'error':
        // Keep error separate from content so historical messages don't carry
        // an "Error:" prefix that pollutes the saved text. The UI renders
        // msg.error as a distinct banner above the prose. Also clear repairing
        // so the spinner doesn't coexist with the error.
        return clearRepairing({ ...msg, error: event.message, streaming: false });

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
    return { ...prev, messages: finalized, isRunning, runId, runAgentId: null, activity: null };
  }

  return { ...prev, messages, isRunning, runId };
}
