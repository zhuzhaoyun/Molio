/**
 * useChatCore — shared chat logic for all chat-based UIs.
 *
 * Handles SSE subscription, event processing, message state, multi-turn,
 * cancel, tool result submission, reset, and rewind-resend.
 *
 * Callers provide a `createRun` function to decide which API endpoint to call
 * and an optional `rewindResend` for regenerating/editing the last user turn.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
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
  /** Frontend-only queue marker — the message is waiting for the current turn
   *  to end before dispatch. Never sent to the daemon, never persisted. */
  queued?: boolean;
}

/** A message queued while a reply is running (see `send` + drain effect). */
export interface QueuedMessage {
  id: string;
  text: string;
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
  /** Messages queued while isRunning — drained one per turn-end. */
  pendingQueue: QueuedMessage[];
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
    pendingQueue: [],
  });

  // 最新已提交 state 的 ref（每次渲染同步）。事件处理器里读「当前状态」必须走它，而不是渲染闭包——
  // 否则 clear()/cancel() 后紧接着 send()（中间无渲染）时，send 会拿到清空前的旧 messages/
  // conversationId，把被清掉的旧消息复活、并续上旧会话（D3 清标签语义被破坏）。这是中断重发
  // （clearAndSend: cancel → clear → send）能读到「已清空」状态的保证。
  const stateRef = useRef(state);
  stateRef.current = state;

  const esRef = useRef<EventSource | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  // 排队 drain 后 assistantIdRef 被重定向到新气泡；上一轮的尾随事件（usage / turn_end）
  // 仍在旧连接上到达，须在「drain → 新气泡首个内容事件」窗口内丢弃，否则会污染新气泡或
  // 提前把它标记为完成（gemini: usage 先于 turn_end）。窗口外一切正常 —— codex/gemini
  // 的 usage 发给仍在 streaming 的消息是合法的（它们不发 turn_end 或 turn_end 在后）。
  const drainedPendingRef = useRef(false);
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
  // The watchdog invokes this to reconnect; set inside attachRun so it
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
   * (set by attachRun) to re-subscribe to the SAME run with ?after=<lastSeq>.
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

  const attachRun = useCallback(async (
    runId: string,
    conversationId: string | null,
    assistantId: string,
    optimisticMessages: ChatMessage[],
  ) => {
    // The passed assistantId is the initial SSE event target. We set the ref
    // here (instead of relying solely on callers) so the parameter is
    // actually used and callers don't need an implicit set-ref-first contract.
    // The ref — not the parameter — is read inside the callback so the
    // multi-turn path (api.sendMessage on an existing run) can retarget
    // events to a new assistant message without resubscribing.
    assistantIdRef.current = assistantId;
    // 全新连接（createRun / rewindAndResend / resumeRun）不会有上一轮的尾随事件。
    drainedPendingRef.current = false;
    clearFallbackTimer();
    clearWatchdog();
    reconnectAttemptRef.current = 0;
    lastSeqRef.current = 0;

    setState((prev) => ({
      ...prev,
      messages: optimisticMessages,
      runId,
      runAgentId: agentId ?? null,
      conversationId,
      isRunning: true,
      activity: null,
    }));

    // --- SSE callbacks (named so the watchdog can re-subscribe with the same
    // callbacks + ?after=<lastSeq> on reconnect) ---
    const onEventCb = (event: AgentEvent, seq?: number) => {
      const currentId = assistantIdRef.current;
      // DEBUG-level, dev only: fires per SSE event. In production this would
      // accumulate in Chromium's console buffer whenever DevTools is open —
      // a real contributor to the renderer's day-long memory growth.
      if (import.meta.env.DEV) {
        console.debug('[chat] event type=' + event.type + ' runId=' + runId + ' assistantId=' + (currentId ?? '(empty)'));
      }
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
      // 尾随窗口：drain 刚重定向、新气泡尚未收到自己的内容 —— 此时到达的 usage / turn_end(end_turn)
      // 属于上一轮，丢弃（不盖章、不提前解锁、不标记完成）。
      if (drainedPendingRef.current && (event.type === 'usage' || (event.type === 'turn_end' && event.stopReason !== 'tool_use'))) {
        return;
      }
      // 新气泡开始流动（内容 / 状态 / 非尾随 turn_end(tool_use) / error）→ 关闭窗口。
      if (event.type !== 'activity' && event.type !== 'usage' && !(event.type === 'turn_end' && event.stopReason !== 'tool_use')) {
        drainedPendingRef.current = false;
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
      // 连接关闭 → 尾随窗口作废（防御：防止 stale 窗口污染后续 run）。
      drainedPendingRef.current = false;
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
    // Closures the named callbacks above; reassigned every attachRun so it
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
  }, [agentId, onComplete, clearFallbackTimer, clearWatchdog, armWatchdog, resetFallbackTimer]);

  /**
   * Dispatch a message to the agent — the shared core for both a normal send
   * and a drained queued message. Tries multi-turn on the existing run first,
   * falls back to createRun. `optimisticMessages` is the full message list
   * AFTER this turn's user+assistant messages are in place (attachRun replaces
   * `messages` with it); its user/assistant members (minus this turn's own
   * user + assistant messages) form the transcript sent to the daemon.
   */
  const dispatchTurn = useCallback(async (
    text: string,
    userMsgId: string,
    assistantMsg: ChatMessage,
    optimisticMessages: ChatMessage[],
  ) => {
    // Route incoming SSE events to the new assistant message.
    assistantIdRef.current = assistantMsg.id;

    // 读最新已提交 state（stateRef 而非渲染闭包）：clear()/cancel() 在同一微任务里同步改过
    // stateRef 后，紧跟的 send() 必须看到清空后的 messages/conversationId（D3 清标签语义）。
    const cur = stateRef.current;
    const existingRunId = cur.runId;
    const agentChanged = agentId != null && cur.runAgentId != null && agentId !== cur.runAgentId;
    if (existingRunId && !agentChanged) {
      try {
        await api.sendMessage(existingRunId, text);
        // Multi-turn reuses the existing SSE subscription, which does NOT
        // re-arm the fallback timer (attachRun isn't called). Re-arm here so
        // a hung follow-up turn still force-unlocks instead of spinning
        // forever. Events from this turn keep resetting it (idle semantics).
        resetFallbackTimer();
        return; // SSE is still active, events route via assistantIdRef
      } catch {
        // Multi-turn failed — fall through to new run
      }
    }

    // Build history for transcript — everything except THIS turn's user +
    // assistant messages (the user message is the `message` prompt; the
    // assistant message is empty/streaming). Still-queued messages (queued:
    // true, not yet dispatched) are excluded too so the agent doesn't answer
    // them prematurely before their own turn.
    const history = optimisticMessages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.id !== userMsgId && m.id !== assistantMsg.id && !m.queued)
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
        message: text,
        history,
        conversationId: cur.conversationId,
      });
      await attachRun(result.runId, result.conversationId ?? cur.conversationId, assistantMsg.id, optimisticMessages);
    } catch (err) {
      const errId = assistantMsg.id;
      setState((prev) => {
        const messages = prev.messages.map((msg) =>
          msg.id === errId
            ? { ...msg, error: (err as Error).message, streaming: false }
            : msg
        );
        return { ...prev, messages, isRunning: false };
      });
    }
  }, [agentId, closeEventSource, createRun, attachRun, resetFallbackTimer]);

  /**
   * Send a message. With `{ queueIfRunning: true }`, a send while `isRunning`
   * queues the message (appears immediately with `queued: true`, dispatched by
   * the drain effect after the current turn ends) instead of interleaving.
   * All other callers (form submit, "继续", wiki auto-send) keep the flag off —
   * they must reach the agent immediately.
   */
  const send = useCallback(async (text: string, opts?: { queueIfRunning?: boolean }) => {
    if (!text.trim()) return;
    const trimmed = text.trim();
    const cur = stateRef.current;

    // 排队路径：回复进行中发送 → 乐观 user 消息立即上屏 + 标记 queued，等 turn 结束再下发。
    if (opts?.queueIfRunning && cur.isRunning) {
      const userMsg: ChatMessage = {
        id: nextMsgId(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        queued: true,
      };
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMsg],
        pendingQueue: [...prev.pendingQueue, { id: userMsg.id, text: trimmed }],
      }));
      return;
    }

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: nextMsgId(),
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

    await dispatchTurn(trimmed, userMsg.id, assistantMsg, [...cur.messages, userMsg, assistantMsg]);
  }, [dispatchTurn]);

  // 排队 drain：当前 turn 结束后（isRunning → false）按序下发 pendingQueue 中的消息。
  // 任何解锁路径（turn_end / usage / status completed / onDone / fallback）都会触发。
  // drain 后立即 isRunning=true，effect 不会对同一条重复处理；多条排队逐 turn 下发；
  // 下发失败（createRun 抛错）→ 标 error、isRunning=false → 继续 drain 下一条。
  useEffect(() => {
    if (stateRef.current.isRunning) return;
    const first = stateRef.current.pendingQueue[0];
    if (!first) return;

    const assistantMsg: ChatMessage = {
      id: nextMsgId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      tools: [],
    };
    // 去掉该用户消息的 queued 标记（徽标消失）并追加本条 assistant 消息。
    const messages = stateRef.current.messages.map((m) =>
      m.id === first.id ? { ...m, queued: false } : m
    );
    const optimistic = [...messages, assistantMsg];
    setState((prev) => ({
      ...prev,
      pendingQueue: prev.pendingQueue.slice(1),
      messages: optimistic,
      isRunning: true,
    }));
    // 进入尾随窗口：此后到达的 usage / turn_end(end_turn) 属于上一轮（旧连接尾随），
    // 在新气泡首个内容事件前丢弃，避免污染新气泡或提前把它标记为完成。
    drainedPendingRef.current = true;
    void dispatchTurn(first.text, first.id, assistantMsg, optimistic);
    // 依赖用响应式 state 触发 effect；body 读 stateRef.current（与渲染闭包在 effect 运行时等价的已提交 state）。
    // 排队是纯前端语义：cancel/reset/setMessages 会清空 pendingQueue 并作废 queued 气泡（见 §6 设计）。
  }, [state.isRunning, state.pendingQueue, dispatchTurn]);

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

    const prevMessages = state.messages
      .slice(0, lastUserIdx) // everything before last user msg
      .map((m) => (m.queued ? { ...m, queued: false } : m)); // 重发丢弃尾部 → 残余 queued 气泡作废
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

    // 重发丢弃消息尾部，排队消息必须随之作废 —— 同步清空队列（写 stateRef + setState，
    // 与 cancel/reset 一致），避免残留 queued 消息在重发后 ghost drain。
    const cleared = { ...stateRef.current, pendingQueue: [] };
    stateRef.current = cleared;
    setState((prev) => ({ ...prev, pendingQueue: [] }));

    try {
      const result = await rewindResend({ conversationId: convId, newContent: newContent.trim() });
      await attachRun(result.runId, result.conversationId ?? convId, newAssistantId, [...prevMessages, newUserMsg, newAssistantMsg]);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        // 队列已清空，但残余 queued 气泡仍需摘掉徽标，避免 stale badge 残留。
        messages: prev.messages.map((m) => (m.queued ? { ...m, queued: false } : m)).concat([{
          id: nextMsgId(),
          role: 'error',
          content: `Error: ${(err as Error).message}`,
          timestamp: Date.now(),
        } as ChatMessage]),
        isRunning: false,
      }));
    }
  }, [rewindResend, state.conversationId, state.messages, closeEventSource, attachRun]);

  /**
   * Resume an in-progress run after the chat was remounted / conversation switched
   * (KB 会话切页返回、历史切换)。守卫：消息列表最后一条必须是 user —— 说明本轮
   * assistant 回复尚未持久化、正在生成；最后一条是 assistant = 本轮已结束并入库，
   * 恢复会重复，跳过。
   * subscribeToRun 不带 after → daemon 从 seq 0 回放全部 buffer 事件（上限 2000），
   * 重建进行中的回复并在回放结束后继续直播（run 在 daemon 侧一直活着）。
   */
  const resumeRun = useCallback((opts: { runId: string }) => {
    const msgs = stateRef.current.messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'user' || last.queued) return; // queued 消息尚未进入回复，跳过恢复
    const newAssistantId = nextMsgId();
    const assistantMsg: ChatMessage = {
      id: newAssistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      tools: [],
    };
    void attachRun(opts.runId, stateRef.current.conversationId, newAssistantId, [...msgs, assistantMsg]);
  }, [attachRun]);

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
    if (stateRef.current.runId) {
      await api.cancelRun(stateRef.current.runId);
    }
    closeEventSource();
    assistantIdRef.current = null;
    drainedPendingRef.current = false;

    // 同步更新 stateRef：调用方（clearAndSend 中断路径）可能在同一事件循环里紧跟 send()，
    // 必须让 send 读到「已取消、runId 已清」的最新状态。
    const prev = stateRef.current;
    // 排队消息作废（设计 §6）：停止时把 queued 消息一并从会话移除，避免残留「排队中」徽标。
    const messages = prev.messages
      .filter((msg) => !msg.queued)
      .map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg));
    const next = { ...prev, messages, isRunning: false, runId: null, runAgentId: null, activity: null, pendingQueue: [] };
    stateRef.current = next;
    setState(next);
  }, [closeEventSource]);

  const reset = useCallback(() => {
    closeEventSource();
    assistantIdRef.current = null;
    drainedPendingRef.current = false;
    messageSelectionStore.exit();
    const next = { messages: [], runId: null, runAgentId: null, isRunning: false, conversationId: null, activity: null, pendingQueue: [] };
    stateRef.current = next;
    setState(next);
  }, [closeEventSource]);

  /**
   * Replace messages and conversationId (used by loadConversation in useChat).
   * 同步更新 stateRef —— 调用方（clearAndSend）在同一次 clear→send 里必须先看到清空结果。
   */
  const setMessages = useCallback((messages: ChatMessage[], conversationId?: string | null) => {
    closeEventSource();
    assistantIdRef.current = null;
    drainedPendingRef.current = false;
    messageSelectionStore.exit();
    const next = {
      messages,
      runId: null,
      runAgentId: null,
      isRunning: false,
      conversationId: conversationId ?? null,
      activity: null,
      pendingQueue: [],
    };
    stateRef.current = next;
    setState(next);
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
        pendingQueue: prev.pendingQueue.filter((q) => !ids.includes(q.id)),
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
    resumeRun,
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
