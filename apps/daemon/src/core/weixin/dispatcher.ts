import type Database from 'better-sqlite3';
import type { AgentEvent, ChatMessage } from '@molio/contracts';
import type { RunManager } from '../RunManager.js';
import type { ConversationService } from '../conversations/service.js';
import { buildMolioPrompt, buildWeixinFrameMessage } from './message.js';
import { extractOutboundMedia } from './outbound-media.js';
import type { OutboundMediaItem } from './types.js';

const RUN_REPLY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Dependencies the dispatcher needs from the weixin channel. The dispatcher
 * owns run/queue state and event handling; the channel owns the actual send
 * path (which depends on `api` + `contextTokens` — channel concerns).
 */
export interface DispatchDeps {
  runManager: RunManager;
  conversations: ConversationService;
  db?: Database.Database;
  /** Send a text reply chunk to the user (from WeixinService.sendText). */
  sendText: (toUserId: string, text: string) => Promise<void>;
  /** Send a media file attachment (from WeixinService.sendMediaFile). */
  sendMediaFile: (toUserId: string, item: OutboundMediaItem) => Promise<void>;
  /** Notify the channel when the active run changes (WeixinService writes status.activeRunId). */
  onActiveRun?: (runId: string | null) => void;
}

/** A single user message awaiting dispatch into a (reused or fresh) run. */
export interface DispatchRequest {
  fromUserId: string;
  conversationId: string;
  agentId: string;
  cwd: string | undefined;
  /**
   * Already attachment-rewritten raw user text. `materializeAttachments` runs
   * in the channel before dispatch; the dispatcher wraps it via buildMolioPrompt.
   */
  rawUserText: string;
  /** Prior conversation history (only consumed on a fresh spawn). */
  history: ChatMessage[];
}

/**
 * Per-WeChat-user reusable run state.
 *
 * Messages from the same user reuse one multi-turn run (Claude Code keeps stdin
 * open across turns) instead of spawning a fresh process per message. `busy`
 * serializes turns: while a turn is in flight, later messages are buffered in
 * `queue` and drained on `turn_end`. This preserves the agent's native session
 * continuity (and prompt cache) across weixin messages.
 */
interface UserRunState {
  runId: string;
  busy: boolean;
  queue: QueuedMessage[];
}

/** A message buffered while a turn is in flight for the same user. */
interface QueuedMessage {
  fromUserId: string;
  conversationId: string;
  agentId: string;
  cwd: string | undefined;
  rawUserText: string;
}

/**
 * Multi-turn run dispatcher for the weixin channel.
 *
 * Owns the per-user run reuse state machine: reuse the active multi-turn run,
 * queue while a turn is in flight (drain on `turn_end`), or spawn a fresh run
 * when the prior one is no longer receptive. The weixin channel frame is
 * prepended to the message on a fresh spawn (see `buildWeixinFrameMessage`), so
 * a queued message drained into a fresh spawn still carries the channel frame.
 */
export class WeixinRunDispatcher {
  private userRuns = new Map<string, UserRunState>();

  constructor(private readonly deps: DispatchDeps) {}

  /** Whether the user currently has a reusable (alive, multi-turn) run. */
  canReuse(fromUserId: string): boolean {
    const state = this.userRuns.get(fromUserId);
    return !!state && this.deps.runManager.canAcceptMessage(state.runId);
  }

  /**
   * Dispatch a weixin user message: reuse the active multi-turn run, queue it
   * while a turn is in flight, or spawn a fresh run. User messages are
   * persisted at dispatch time (after flushing any pending assistant reply)
   * so DB position ordering matches the real conversation order.
   */
  async dispatch(req: DispatchRequest): Promise<void> {
    const { fromUserId, conversationId, agentId, cwd, rawUserText, history } = req;
    const runMessage = buildMolioPrompt(rawUserText);
    const state = this.userRuns.get(fromUserId);

    if (state && this.deps.runManager.canAcceptMessage(state.runId)) {
      if (state.busy) {
        // A turn is in flight — buffer and drain on its turn_end.
        state.queue.push({ fromUserId, conversationId, agentId, cwd, rawUserText });
        return;
      }
      state.busy = true;
      // Persist the pending assistant reply BEFORE the next user message so
      // ordering stays correct (mirrors the desktop POST /:id/messages path).
      this.deps.runManager.flushPendingReply(state.runId);
      this.deps.conversations.appendUserMessage(conversationId, rawUserText);
      // No channel frame here: sendMessage reuses the live process, which
      // already carries the frame prepended on its first (fresh-spawn) turn.
      this.deps.runManager.sendMessage(state.runId, runMessage);
      this.deps.onActiveRun?.(state.runId);
      await this.deps.sendText(fromUserId, 'Molio 正在处理...');
      void this.forwardRunReply(state.runId, fromUserId, conversationId, agentId, cwd);
      return;
    }

    // No reusable run — cancel any stale tracked run for this user, then spawn.
    if (state) {
      this.deps.runManager.cancelRun(state.runId);
      this.userRuns.delete(fromUserId);
    }
    this.deps.conversations.appendUserMessage(conversationId, rawUserText);
    // The weixin channel frame is prepended HERE (fresh spawn only), not frozen
    // at queue time — a queued message drained into a fresh spawn gets re-framed.
    const runId = await this.deps.runManager.createRun({
      agentId,
      cwd,
      message: buildWeixinFrameMessage(rawUserText),
      conversationId,
      history,
    });
    this.userRuns.set(fromUserId, { runId, busy: true, queue: [] });
    this.deps.onActiveRun?.(runId);
    await this.deps.sendText(fromUserId, 'Molio 正在处理...');
    void this.forwardRunReply(runId, fromUserId, conversationId, agentId, cwd);
  }

  /**
   * Drain the next queued message for a user after a turn completed. Called
   * from forwardRunReply's finish(). If the run died mid-conversation, the
   * next dispatch falls back to a fresh spawn (and re-derives the wiki frame).
   */
  private drainQueue(fromUserId: string): void {
    const state = this.userRuns.get(fromUserId);
    if (!state) return;
    state.busy = false;
    const next = state.queue.shift();
    if (!next) return;
    void this.dispatch({ ...next, history: [] });
  }

  /** Cancel and forget the reusable run for a user (e.g. on /new or stop). */
  cancelUser(fromUserId: string): void {
    const state = this.userRuns.get(fromUserId);
    if (!state) return;
    this.deps.runManager.cancelRun(state.runId);
    this.userRuns.delete(fromUserId);
  }

  /** Cancel every active user run (used on stop). */
  cancelAll(): void {
    for (const fromUserId of Array.from(this.userRuns.keys())) {
      this.cancelUser(fromUserId);
    }
  }

  private async forwardRunReply(
    runId: string,
    toUserId: string,
    conversationId: string,
    agentId: string,
    cwd: string | undefined,
  ): Promise<void> {
    let reply = '';
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const finish = async (text: string, opts?: { cancelRun?: boolean }) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      clearTimeout(timer);
      // On timeout we give up on this turn's reply; cancel the run so a
      // queued follow-up spawns fresh instead of writing into a run that is
      // still grinding on the previous message.
      if (opts?.cancelRun) {
        this.deps.runManager.cancelRun(runId);
      }
      // Pull out <attach/> markers: those files are delivered as real WeChat
      // attachments; the markers are stripped from `cleanText` so the phone
      // never sees a local path. Delivery is explicit-only — files the AI
      // writes via Write/Edit are NOT auto-delivered (that would spam the
      // user with every .md produced during ingestion).
      const { items, text: cleanText } = extractOutboundMedia(text, cwd);
      this.deps.conversations.appendAssistantMessage(conversationId, cleanText || text, { agentId, runId });
      if (cleanText) {
        await this.deps.sendText(toUserId, cleanText);
      }
      for (const item of items) {
        await this.deps.sendMediaFile(toUserId, item);
      }
      // Drain the next queued message (no-op if queue empty).
      this.drainQueue(toUserId);
    };

    const handleEvent = (event: AgentEvent) => {
      if (event.type === 'text_delta') {
        reply += event.delta;
        return;
      }

      // tool_use events are intentionally not handled here — file delivery is
      // explicit-only via <attach/> markers parsed from the reply text, so we
      // don't need to track which files the AI wrote.

      if (event.type === 'error') {
        void finish(`Molio 处理失败：${event.message}`);
        return;
      }

      if (event.type === 'turn_end') {
        const text = reply.trim();
        void finish(text || 'Molio 已完成处理，但没有返回文本内容。');
        return;
      }

      if (event.type === 'status' && (event.label === 'failed' || event.label === 'canceled')) {
        void finish(`Molio 运行已${event.label === 'failed' ? '失败' : '取消'}。`);
        return;
      }

      if (event.type === 'status' && event.label === 'completed') {
        const text = reply.trim();
        void finish(text || 'Molio 已完成处理，但没有返回文本内容。');
      }
    };

    const timer = setTimeout(() => {
      void finish(
        reply.trim() || `Molio 仍在处理，稍后可在桌面端查看运行：${runId}`,
        { cancelRun: true },
      );
    }, RUN_REPLY_TIMEOUT_MS);
    timer.unref?.();

    unsubscribe = this.deps.runManager.onEvent(runId, handleEvent);
    if (!unsubscribe) {
      clearTimeout(timer);
      await this.deps.sendText(toUserId, `Molio 已创建运行，但无法订阅结果：${runId}`);
    }
  }
}
