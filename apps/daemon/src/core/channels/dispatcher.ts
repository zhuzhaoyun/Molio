import type Database from 'better-sqlite3';
import type { AgentEvent, ChatMessage } from '@molio/contracts';
import type { RunManager } from '../RunManager.js';
import type { ConversationService } from '../conversations/service.js';
import { extractOutboundMedia, type OutboundMediaFailReason } from './outbound-media.js';
import type { ChannelSink } from './types.js';

const RUN_REPLY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * User-facing phrasing for why an `<attach/>` marker could not be delivered.
 * The reply text usually already claimed the file was attached, so these must
 * be surfaced to the user — never logged-and-dropped.
 */
const ATTACH_FAIL_TEXT: Record<OutboundMediaFailReason, string> = {
  'blocked-traversal': '路径被安全策略拦截',
  'not-found': '找不到该文件',
  'not-a-file': '该路径不是文件',
  'unsupported-type': '文件类型不支持发送',
};

/** Last path segment of a raw (possibly relative) marker path. */
function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}
/**
 * Hard cap on the per-user pending queue. The daemon is single-user local, so
 * a flood of messages from one user is almost always a stuck agent rather
 * than real traffic — cap the queue and drop the oldest pending message with
 * a visible "queue overflow" reply so the user knows something was dropped.
 */
const QUEUE_MAX_PENDING = 16;
/**
 * Cap on the accumulated reply text. A stuck agent (e.g. infinite loop
 * emitting `text_delta`s) could otherwise grow `reply` unbounded and OOM
 * the daemon. Truncating at ~1MB still leaves the user a substantial reply
 * to read; the agent's run itself is also timeout-bounded by RunManager.
 */
const REPLY_MAX_CHARS = 1_000_000;

/**
 * Wrap raw user text into a channel-specific prompt (e.g. weixin wraps
 * mp.weixin URLs with an article-summary preface). Falls through to identity
 * when the channel has no special preface for this message.
 */
export type PromptBuilder = (rawUserText: string) => string;

/**
 * Dependencies the shared dispatcher needs. The dispatcher owns run/queue
 * state and event handling; the channel (via `sink`) owns the actual send path
 * (which depends on per-channel API + token state — channel concerns).
 */
export interface ChannelDispatcherDeps {
  runManager: RunManager;
  conversations: ConversationService;
  db?: Database.Database;
  /** Push replies back to the user (text + media attachments). */
  sink: ChannelSink;
  /** Wrap raw user text into the channel-specific prompt (default: identity). */
  buildPrompt?: PromptBuilder;
  /**
   * Wrap raw user text for a FRESH spawn ONLY (e.g. weixin/feishu prepend
   * their channel role frame). Unlike `buildPrompt` (applied to every turn),
   * this runs only when a new run is spawned — reuse turns must NOT re-carry
   * the frame: the live process already holds it from its first turn. A
   * message prepend is the ONLY reliable way to deliver a channel frame:
   * --append-system-prompt-file is silently dropped by the CLI in some
   * environments (verified on Claude Code), and long sessions lose even a
   * delivered frame to context compaction.
   */
  frameFirstTurn?: PromptBuilder;
  /**
   * Wrap raw user text for REUSE turns ONLY — the counterpart to
   * `frameFirstTurn`. A reused multi-turn run carries the first-turn frame in
   * its history, but long sessions get context-compacted: the frame's
   * mechanics (notably the `<attach/>` file-delivery protocol) are summarized
   * away and the model starts telling users it "has no way to send files"
   * (verified incident 2026-08-11). A compact per-turn reminder keeps the
   * protocol known for the whole life of the run. Like `frameFirstTurn`, this
   * SUBSUMES `buildPrompt` — implementations wrap the raw text themselves.
   * Keep it SHORT: it rides every reuse turn, and a full-frame re-prepend
   * would re-trigger ingestion/routing behavior on every message.
   */
  reuseTurnReminder?: PromptBuilder;
  /** Channel label for diagnostics logs (e.g. 'weixin', 'feishu'). */
  channelLabel: string;
}

/** A single user message awaiting dispatch into a (reused or fresh) run. */
export interface DispatchRequest {
  userId: string;
  conversationId: string;
  agentId: string;
  cwd: string | undefined;
  /**
   * Already attachment-rewritten raw user text. The channel's
   * `materializeAttachments` runs before dispatch; the dispatcher wraps it via
   * `buildPrompt` (when provided).
   */
  rawUserText: string;
  /** Prior conversation history (only consumed on a fresh spawn). */
  history: ChatMessage[];
}

/**
 * Per-user reusable run state.
 *
 * Messages from the same user reuse one multi-turn run (Claude Code keeps stdin
 * open across turns) instead of spawning a fresh process per message. `busy`
 * serializes turns: while a turn is in flight, later messages are buffered in
 * `queue` and drained on `turn_end`. This preserves the agent's native session
 * continuity (and prompt cache) across IM messages.
 */
interface UserRunState {
  runId: string;
  busy: boolean;
  queue: QueuedMessage[];
}

/** A message buffered while a turn is in flight for the same user. */
interface QueuedMessage {
  userId: string;
  conversationId: string;
  agentId: string;
  cwd: string | undefined;
  rawUserText: string;
}

/**
 * Multi-turn run dispatcher shared across IM channels (weixin / feishu / future
 * wecom).
 *
 * Owns the per-user run reuse state machine: reuse the active multi-turn run,
 * queue while a turn is in flight (drain on `turn_end`), or spawn a fresh run
 * when the prior one is no longer receptive. The channel role frame is applied
 * at spawn time via `frameFirstTurn`, so a queued message drained into a
 * fresh spawn still carries the frame.
 */
export class ChannelDispatcher {
  private userRuns = new Map<string, UserRunState>();

  constructor(private readonly deps: ChannelDispatcherDeps) {}

  /** Whether the user currently has a reusable (alive, multi-turn) run. */
  canReuse(userId: string): boolean {
    const state = this.userRuns.get(userId);
    return !!state && this.deps.runManager.canAcceptMessage(state.runId);
  }

  /**
   * Dispatch an IM user message: reuse the active multi-turn run, queue it
   * while a turn is in flight, or spawn a fresh run. User messages are
   * persisted at dispatch time (after flushing any pending assistant reply)
   * so DB position ordering matches the real conversation order.
   */
  async dispatch(req: DispatchRequest): Promise<void> {
    const { userId, conversationId, agentId, cwd, rawUserText, history } = req;
    const runMessage = this.deps.buildPrompt ? this.deps.buildPrompt(rawUserText) : rawUserText;
    const state = this.userRuns.get(userId);

    if (state && this.deps.runManager.canAcceptMessage(state.runId)) {
      if (state.busy) {
        // A turn is in flight — buffer and drain on its turn_end.
        if (state.queue.length >= QUEUE_MAX_PENDING) {
          const dropped = state.queue.shift()!;
          // Don't await — overflow reply is fire-and-forget; we need to make
          // room for the new message before pushing it.
          void this.deps.sink.sendText(
            userId,
            'Molio 消息队列已满，最早一条排队消息被丢弃。',
          ).catch(() => {});
          this.deps.conversations.appendAssistantMessage(
            dropped.conversationId,
            'Molio 消息队列已满，此消息被丢弃。',
            { agentId: dropped.agentId },
          );
        }
        state.queue.push({ userId, conversationId, agentId, cwd, rawUserText });
        return;
      }
      state.busy = true;
      // Persist the pending assistant reply BEFORE the next user message so
      // ordering stays correct (mirrors the desktop POST /:id/messages path).
      this.deps.runManager.flushPendingReply(state.runId);
      this.deps.conversations.appendUserMessage(conversationId, rawUserText);
      // No frame here: sendMessage reuses the live process, which already
      // carries the first-turn frame in its history. The optional
      // `reuseTurnReminder` re-anchors protocol bits the first-turn frame
      // taught (e.g. the <attach/> file delivery) — long sessions lose the
      // frame to context compaction, the reminder survives it.
      const reuseMessage = this.deps.reuseTurnReminder
        ? this.deps.reuseTurnReminder(rawUserText)
        : runMessage;
      this.deps.runManager.sendMessage(state.runId, reuseMessage);
      this.deps.sink.onActiveRun?.(state.runId);
      await this.deps.sink.sendText(userId, 'Molio 正在处理...');
      this.spawnForward(state.runId, userId, conversationId, agentId, cwd);
      return;
    }

    // No reusable run — cancel any stale tracked run for this user, then spawn.
    if (state) {
      this.deps.runManager.cancelRun(state.runId);
      this.userRuns.delete(userId);
    }
    this.deps.conversations.appendUserMessage(conversationId, rawUserText);
    // Fresh-spawn message: `frameFirstTurn` (e.g. weixin/feishu channel-frame
    // prepend) applies HERE only — reuse turns keep the plain buildPrompt
    // output (or the compact `reuseTurnReminder`). Applied at spawn time, not
    // frozen at queue time — a queued message drained into a fresh spawn still
    // gets the channel frame.
    const spawnMessage = this.deps.frameFirstTurn
      ? this.deps.frameFirstTurn(rawUserText)
      : runMessage;
    const runId = await this.deps.runManager.createRun({
      agentId,
      cwd,
      message: spawnMessage,
      conversationId,
      history,
    });
    this.userRuns.set(userId, { runId, busy: true, queue: [] });
    this.deps.sink.onActiveRun?.(runId);
    await this.deps.sink.sendText(userId, 'Molio 正在处理...');
    this.spawnForward(runId, userId, conversationId, agentId, cwd);
  }

  /**
   * Fire-and-forget wrapper for `forwardRunReply` — guarantees that any
   * rejection (failed createRun teardown, sendText throw, etc.) becomes a
   * logged error + user-facing message instead of an unhandledRejection.
   */
  private spawnForward(
    runId: string,
    userId: string,
    conversationId: string,
    agentId: string,
    cwd: string | undefined,
  ): void {
    this.forwardRunReply(runId, userId, conversationId, agentId, cwd).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[${this.deps.channelLabel}] forwardRunReply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      void this.deps.sink.sendText(
        userId,
        `Molio 处理失败：${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    });
  }

  /**
   * Drain the next queued message for a user after a turn completed. Called
   * from forwardRunReply's finish(). If the run died mid-conversation, the
   * next dispatch falls back to a fresh spawn (and re-derives the wiki frame).
   */
  private drainQueue(userId: string): void {
    const state = this.userRuns.get(userId);
    if (!state) return;
    state.busy = false;
    const next = state.queue.shift();
    if (!next) return;
    // Wrap in a catch so a failing fresh-spawn dispatch never reaches
    // process.unhandledRejection (the user's IM thread would otherwise
    // hang with no reply at all).
    this.dispatch({ ...next, history: [] }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[${this.deps.channelLabel}] drainQueue dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      void this.deps.sink.sendText(
        userId,
        `Molio 处理排队消息失败：${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
    });
  }

  /** Cancel and forget the reusable run for a user (e.g. on /new or stop). */
  cancelUser(userId: string): void {
    const state = this.userRuns.get(userId);
    if (!state) return;
    this.deps.runManager.cancelRun(state.runId);
    this.userRuns.delete(userId);
  }

  /** Cancel every active user run (used on stop). */
  cancelAll(): void {
    for (const userId of Array.from(this.userRuns.keys())) {
      this.cancelUser(userId);
    }
  }

  private async forwardRunReply(
    runId: string,
    userId: string,
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
      // Pull out <attach/> markers: those files are delivered as real IM
      // attachments; the markers are stripped from `cleanText` so the phone
      // never sees a local path. Delivery is explicit-only — files the AI
      // writes via Write/Edit are NOT auto-delivered (that would spam the
      // user with every .md produced during ingestion).
      const { items, text: cleanText, failed } = extractOutboundMedia(text, cwd);
      const hadMarkers = items.length > 0 || failed.length > 0;
      // When markers were stripped, persist cleanText as-is: falling back to
      // raw `text` (the old `cleanText || text`) would leak the markers'
      // local paths into conversation history for attachment-only replies.
      const persistText = hadMarkers ? (cleanText || '（附件，无文字说明）') : (cleanText || text);
      this.deps.conversations.appendAssistantMessage(conversationId, persistText, { agentId, runId });
      if (cleanText) {
        await this.deps.sink.sendText(userId, cleanText);
      }
      // Deliver each attachment independently: one failure must not block the
      // rest, and every failure is collected so the user is TOLD at the end —
      // the reply text already claims the files were attached, so silently
      // skipping them leaves the user waiting for files that never arrive
      // (2026-08-23 feishu incident: "已附上" text, no files, no notice).
      const sendFailed: Array<{ fileName: string; error: string }> = [];
      for (const item of items) {
        try {
          await this.deps.sink.sendMediaFile(userId, item);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.log(
            `[${this.deps.channelLabel}-attach] send-failed reason=sink-error file=${item.filePath} err=${msg}`,
          );
          sendFailed.push({ fileName: item.fileName, error: msg });
        }
      }
      // Visible failure notice — unresolved markers + send failures. Nothing
      // may be dropped silently here: the user-facing text said "已附上".
      const problems: string[] = [];
      for (const f of failed) {
        // eslint-disable-next-line no-console
        console.log(
          `[${this.deps.channelLabel}-attach] undelivered reason=${f.reason} path=${f.path}`,
        );
        problems.push(`「${basenameOf(f.path)}」（${ATTACH_FAIL_TEXT[f.reason]}）`);
      }
      for (const s of sendFailed) {
        problems.push(`「${s.fileName}」（发送失败：${s.error}）`);
      }
      if (problems.length > 0) {
        const notice = `⚠️ 有 ${problems.length} 个附件未能发送：${problems.join('；')}`;
        this.deps.conversations.appendAssistantMessage(conversationId, notice, { agentId, runId });
        await this.deps.sink.sendText(userId, notice).catch(() => {});
      }
      // Stale-run cleanup: if the run is no longer receptive AND there's
      // nothing queued to drain into a fresh spawn, drop the per-user entry
      // now so it doesn't linger forever (the entry would otherwise sit in
      // userRuns with a dead runId until the user sends the next message).
      const state = this.userRuns.get(userId);
      if (state && state.runId === runId && state.queue.length === 0
          && !this.deps.runManager.canAcceptMessage(runId)) {
        this.userRuns.delete(userId);
      }
      // Drain the next queued message (no-op if queue empty).
      this.drainQueue(userId);
    };

    const handleEvent = (event: AgentEvent) => {
      if (event.type === 'text_delta') {
        if (reply.length < REPLY_MAX_CHARS) {
          reply += event.delta;
          if (reply.length > REPLY_MAX_CHARS) {
            reply = reply.slice(0, REPLY_MAX_CHARS) + '\n…[回复被截断：超过字符上限]';
          }
        }
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
      await this.deps.sink.sendText(userId, `Molio 已创建运行，但无法订阅结果：${runId}`);
    }
  }
}

// Re-export shared types so channel modules importing from 'channels/dispatcher'
// don't need a second import path for them.
export type { ChannelSink, OutboundMediaItem } from './types.js';
