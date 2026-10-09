import type { AgentEvent } from '@molio/contracts';

/**
 * AcpTransport — JSON-RPC 2.0 client over newline-delimited JSON frames,
 * for agents that implement the Agent Client Protocol (e.g. Hermes via `hermes-acp`).
 *
 * Unlike StreamHandler (one-way stdout → events), this is bidirectional:
 *  - feed(chunk): stdout in → parses JSON-RPC frames, dispatches responses + notifications
 *  - request(method, params): sends a request on stdin, returns a Promise resolved by the matching response
 *  - notify(method, params): sends a notification (no response expected)
 *
 * Lifecycle: 1 AcpTransport instance = 1 long-running agent process = **N ACP
 * sessions**. The transport is owned by an AcpPool entry (one warm process per
 * agent); each Molio run registers its session via registerSession() and
 * receives only the session/update notifications carrying its own sessionId.
 * (Hermes supports this natively — acp_adapter keeps a `_sessions` dict and
 * cancels per session; verified in the installed source.)
 *
 * Turn boundary: `session/prompt` is a request — its Promise resolution IS the turn
 * end (stopReason comes from PromptResponse). session/update notifications streamed
 * during the await are mapped to AgentEvents and routed to the session's sink.
 *
 * ── Activity-based timeouts ──
 *
 * `request()` uses an **idle** timer, not an absolute deadline. The idle timer
 * resets whenever the agent produces output (stdout via `feed()` or stderr via
 * `noteActivity()`). This adapts to slow cold starts: as long as the agent is
 * still printing (loading plugins, connecting providers), the request stays
 * pending. Only a truly hung agent (no output for `idleTimeoutMs`) times out.
 * An `absoluteTimeoutMs` safety-net cap is also enforced.
 *
 * ── Timeout blast radius (pooled process) ──
 *
 * A request sent with `options.sessionId` is **session-scoped**: its timeout
 * rejects only that request (failing the owning run) and does NOT kill the
 * shared process — other conversations' sessions must survive one hung prompt.
 * Requests WITHOUT a sessionId (initialize, session/new) are transport-level:
 * their timeout kills the child, since a process that can't complete a
 * handshake is useless to every session.
 */

export interface RequestOptions {
  /**
   * Idle timeout: if no stdout/stderr activity arrives for this long, reject.
   * If undefined, no idle timer is set (request waits up to absoluteTimeoutMs).
   */
  idleTimeoutMs?: number;
  /**
   * Absolute deadline from request send time, as a safety net.
   * If undefined, no absolute cap (request waits indefinitely, subject to idle timer).
   */
  absoluteTimeoutMs?: number;
  /**
   * Session scope. When set:
   *  - idle/absolute timeouts reject this request WITHOUT killing the shared
   *    child process (one hung session must not take down the others);
   *  - the request is counted by hasPendingFor(sessionId) so the pool can tell
   *    "process died mid-prompt for THIS session" from "died while idle".
   * Leave unset for transport-level requests (initialize, session/new) whose
   * failure means the whole process is unusable.
   */
  sessionId?: string;
}

export interface AcpTransportHooks {
  /**
   * Receives transport-level diagnostic events that can't be attributed to a
   * single session: buffer overflow, non-JSON stdout (Python tracebacks),
   * mapUpdate failures, unsupported server requests without a sessionId.
   * The pool broadcasts these to all attached sessions.
   */
  onTransportEvent?: (ev: AgentEvent) => void;
  /**
   * Kills the child process when a TRANSPORT-LEVEL request times out (no
   * sessionId — initialize/session/new) or the transport enters a degraded
   * state. Called AFTER the pending request is rejected so callers fail fast
   * instead of leaking a hung process. Session-scoped timeouts never call
   * this. Default no-op keeps tests/mocks simple.
   */
  killChild?: () => void;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  absoluteTimer?: ReturnType<typeof setTimeout>;
  idleTimeoutMs?: number;
  method: string;
  /** Present when the request is session-scoped (see RequestOptions.sessionId). */
  sessionId?: string;
}

export class AcpTransport {
  /** Cap stdout buffer to prevent unbounded growth from malformed/large payloads. */
  private static readonly MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB

  private buffer = '';
  private pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private cancelledSessionIds = new Set<string>();
  /** sessionId → event sink. session/update notifications are demuxed by sessionId. */
  private sessions = new Map<string, (ev: AgentEvent) => void>();

  constructor(
    /** Writes a complete JSON-RPC frame (including trailing newline) to the agent's stdin. */
    private readonly send: (json: string) => void,
    private readonly hooks: AcpTransportHooks = {},
  ) {}

  /** Register an event sink for a session. Updates for unregistered sessions are dropped. */
  registerSession(sessionId: string, sink: (ev: AgentEvent) => void): void {
    this.sessions.set(sessionId, sink);
  }

  /**
   * Remove a session's sink (run finished/cancelled/detached). Also clears its
   * cancelled marker so cancelledSessionIds doesn't accumulate stale entries
   * across the long-lived pooled process.
   */
  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.cancelledSessionIds.delete(sessionId);
  }

  /** Test/inspection: currently registered session ids. */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Feed a chunk of stdout (string or Buffer) — splits newline-delimited JSON frames. */
  feed(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Any stdout data counts as activity — reset idle timers before parsing.
    this.noteActivity();
    // Parse all complete frames first — a large chunk that contains newlines
    // is legitimate (batched notifications), so we shouldn't trigger overflow
    // on the total chunk size, only on the leftover incomplete-frame tail.
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
    // If the remaining buffer (an incomplete frame with no trailing newline)
    // exceeds the cap, the agent is spewing data without newlines — binary
    // garbage, malformed JSON, or a hostile payload. Drop it, emit an error
    // so the user sees the diagnostic, and reject the oldest pending request
    // so the run fails fast instead of waiting for the 30-min absolute timeout.
    if (this.buffer.length > AcpTransport.MAX_BUFFER_SIZE) {
      const dropped = this.buffer.length;
      this.buffer = '';
      const msg = `ACP buffer overflow — dropped ${dropped} bytes without a complete newline`;
      this.hooks.onTransportEvent?.({ type: 'error', message: msg });
      this.rejectOldestPending(new Error(msg));
    }
  }

  /** Process any remaining buffered bytes (called on child exit / stdout end). */
  flush(): void {
    const rem = this.buffer.trim();
    this.buffer = '';
    if (rem) this.handleLine(rem);
  }

  /**
   * Send a JSON-RPC request and return the response's `result`.
   * Rejects on: idle timeout (no activity), absolute timeout (safety net),
   * JSON-RPC error response, or rejectAll() (process exit).
   * Timeouts on session-scoped requests (options.sessionId) do NOT kill the
   * child; transport-level timeouts do (see AcpTransportHooks.killChild).
   */
  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    const id = this.nextId++;
    const { idleTimeoutMs, absoluteTimeoutMs, sessionId } = options;
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        method,
        idleTimeoutMs,
        sessionId,
      };

      if (idleTimeoutMs !== undefined) {
        entry.idleTimer = this.armIdleTimer(id, entry, method, idleTimeoutMs);
      }
      if (absoluteTimeoutMs !== undefined) {
        entry.absoluteTimer = setTimeout(() => {
          if (this.pending.delete(id)) {
            this.clearEntryTimers(entry);
            reject(new Error(`ACP absolute timeout: ${method} (${absoluteTimeoutMs}ms)`));
            this.maybeKillChildOnTimeout(entry);
          }
        }, absoluteTimeoutMs);
      }

      this.pending.set(id, entry);
      this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /**
   * Reset idle timers on all pending requests. Call when the agent produces
   * ANY output (stdout chunk arrived via feed(), or stderr data arrived in
   * the pool's stderr handler).
   */
  noteActivity(): void {
    for (const [id, entry] of this.pending) {
      if (entry.idleTimeoutMs === undefined) continue;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = this.armIdleTimer(id, entry, entry.method, entry.idleTimeoutMs);
    }
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params: unknown): void {
    this.send(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /**
   * Reject all pending requests and drop all session sinks — call when the
   * child process exits. The pool snapshots per-session state (cancelled /
   * had-pending-prompt) BEFORE calling this, since rejectAll clears both maps.
   */
  rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      this.clearEntryTimers(entry);
      entry.reject(error);
    }
    this.pending.clear();
    // No further session/update notifications can arrive — drop the cancelled
    // markers and session sinks so nothing routes to a dead process's runs.
    this.cancelledSessionIds.clear();
    this.sessions.clear();
  }

  /**
   * Reject the oldest pending request (FIFO — Map preserves insertion order,
   * and nextId increments so the first inserted is the oldest). Used when
   * stdout delivers a frame that can't be associated with any specific request:
   * non-JSON output (Python traceback to stdout) or buffer overflow. The
   * caller has already decided the transport is degraded; rejecting the oldest
   * request lets the owning run's catch handler surface the error and finish
   * the run instead of waiting for the idle/absolute timeout.
   *
   * No-op when nothing is pending — the caller is responsible for emitting
   * any standalone error event in that case (see feed() overflow path).
   */
  private rejectOldestPending(error: Error): void {
    const first = this.pending.entries().next();
    if (first.done) return;
    const [id, entry] = first.value;
    this.pending.delete(id);
    this.clearEntryTimers(entry);
    entry.reject(error);
  }

  /** Test/inspection: are there any in-flight requests? */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Does a specific session have an in-flight request (e.g. a pending
   * session/prompt)? The pool uses this on process exit to distinguish a
   * mid-prompt crash ('failed') from a clean shutdown while idle.
   */
  hasPendingFor(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Mark a session as cancelled — subsequent session/update notifications for it are dropped. */
  markCancelled(sessionId: string): void {
    this.cancelledSessionIds.add(sessionId);
  }

  /** Clear the cancelled flag (call after the prompt Promise settles so future prompts flow normally). */
  unmarkCancelled(sessionId: string): void {
    this.cancelledSessionIds.delete(sessionId);
  }

  /** Test-only: inspect cancelled state. */
  isCancelled(sessionId: string): boolean {
    return this.cancelledSessionIds.has(sessionId);
  }

  /** Kill the child on a timeout — only for transport-level requests. */
  private maybeKillChildOnTimeout(entry: PendingEntry): void {
    // Session-scoped timeout: reject already failed the owning run; killing
    // the shared process would take down every other conversation's session.
    // The pool's idle-TTL / crash handling owns the process lifecycle.
    if (entry.sessionId) return;
    this.hooks.killChild?.();
  }

  private armIdleTimer(
    id: number,
    entry: PendingEntry,
    method: string,
    idleTimeoutMs: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.pending.delete(id)) {
        this.clearEntryTimers(entry);
        entry.reject(new Error(`ACP idle timeout: ${method} (no activity for ${idleTimeoutMs}ms)`));
        this.maybeKillChildOnTimeout(entry);
      }
    }, idleTimeoutMs);
  }

  private clearEntryTimers(entry: PendingEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.absoluteTimer) clearTimeout(entry.absoluteTimer);
    entry.idleTimer = undefined;
    entry.absoluteTimer = undefined;
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not valid JSON. Surface as a raw event so the line is preserved in
      // events.jsonl for remote diagnosis. If a request is pending, the
      // agent is likely spewing a Python traceback to stdout (instead of
      // stderr) — reject the oldest pending request so the owning run's catch
      // handler surfaces a diagnostic immediately, rather than the user
      // waiting for the idle timeout (handshake 60s / prompt 5min) with
      // no clue what went wrong. Truncate the raw line so a huge traceback
      // doesn't bloat the event log.
      this.hooks.onTransportEvent?.({
        type: 'raw',
        line: line.length > 500 ? line.slice(0, 500) + '…' : line,
      });
      this.rejectOldestPending(
        new Error(
          `ACP protocol violation: agent wrote non-JSON to stdout: ${line.slice(0, 120)}`,
        ),
      );
      return;
    }

    // Response to a request we sent
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!entry) return; // response for an unknown id (maybe timed out) — drop
      this.clearEntryTimers(entry);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string; data?: unknown };
        entry.reject(new Error(`ACP error ${err.code ?? ''}: ${err.message ?? JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Notification from agent — demux by sessionId to the owning run's sink.
    if (msg.method === 'session/update' && msg.params) {
      const sessionId: string | undefined = msg.params.sessionId;
      if (sessionId && this.cancelledSessionIds.has(sessionId)) return;
      const sink = sessionId ? this.sessions.get(sessionId) : undefined;
      // Unregistered session (detached run, or a session this Molio instance
      // doesn't own) — drop silently.
      if (!sink) return;
      // mapUpdate touches an unstable ACP schema (tool calls, usage). A
      // malformed update (circular ref in JSON.stringify, unexpected shape)
      // or a throwing downstream sink would escape the while loop in feed()
      // and silently drop any subsequent buffered frames. Surface it as a
      // transport-level raw event so the line is preserved for diagnosis,
      // and keep processing the rest of the buffer.
      try {
        this.mapUpdate(msg.params.update, sink);
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        this.hooks.onTransportEvent?.({
          type: 'raw',
          line: `[mapUpdate error] ${errMsg}: ${JSON.stringify(msg.params.update).slice(0, 400)}`,
        });
      }
      return;
    }

    // Server-initiated request (has BOTH id and method) — e.g. dsh's
    // session/request_permission. Must be answered or the agent blocks forever.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.handleServerRequest(msg);
      return;
    }

    // Other notifications (no id) — nothing to answer, safe to ignore.
  }

  /** Route a diagnostic event to the session's sink when attributable, else transport-level. */
  private emitForSessionOrTransport(sessionId: string | undefined, ev: AgentEvent): void {
    const sink = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sink) {
      try { sink(ev); } catch { /* sink error — don't break the frame loop */ }
    } else {
      this.hooks.onTransportEvent?.(ev);
    }
  }

  /**
   * Answer a server-initiated JSON-RPC request.
   *
   * `session/request_permission`: Molio runs agents in an auto-approve posture
   * (claude --dangerously-skip-permissions, codex danger-full-access on Win,
   * dsh DSH_PERMISSION_MODE=workspace-write), and the UI has no permission
   * dialog — so pick the most permissive allow option (allow_always →
   * allow_once → any allow-ish option → first option). The decision is logged
   * as a `raw` event for diagnosis. With no selectable options, answer
   * `cancelled` so the agent proceeds down its rejection path instead of
   * hanging until the idle timeout.
   *
   * Unknown server requests get a spec-compliant -32601 so a well-behaved
   * agent can degrade instead of waiting forever.
   */
  private handleServerRequest(msg: any): void {
    const sessionId: string | undefined = msg.params?.sessionId;
    if (msg.method === 'session/request_permission') {
      const options: any[] = Array.isArray(msg.params?.options) ? msg.params.options : [];
      const byKind = (kind: string) => options.find((o) => o?.kind === kind);
      const chosen =
        byKind('allow_always')
        ?? byKind('allow_once')
        ?? options.find((o) => typeof o?.kind === 'string' && o.kind.startsWith('allow'))
        ?? options.find((o) => typeof o?.optionId === 'string' && o.optionId.startsWith('allow'))
        ?? options[0];
      const toolTitle = msg.params?.toolCall?.title ?? msg.params?.toolCall?.kind ?? '';
      if (chosen && typeof chosen.optionId === 'string') {
        this.emitForSessionOrTransport(sessionId, {
          type: 'raw',
          line: `[acp] auto-approved permission request${toolTitle ? ` (${toolTitle})` : ''}: ${chosen.optionId}`,
        });
        this.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { outcome: { outcome: 'selected', optionId: chosen.optionId } },
        }) + '\n');
      } else {
        this.emitForSessionOrTransport(sessionId, {
          type: 'raw',
          line: `[acp] permission request has no selectable options — answering cancelled${toolTitle ? ` (${toolTitle})` : ''}`,
        });
        this.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { outcome: { outcome: 'cancelled' } },
        }) + '\n');
      }
      return;
    }

    this.emitForSessionOrTransport(sessionId, {
      type: 'raw',
      line: `[acp] unsupported server request: ${msg.method}`,
    });
    this.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    }) + '\n');
  }

  private mapUpdate(update: any, sink: (ev: AgentEvent) => void): void {
    if (!update || typeof update !== 'object') return;
    const tag: string | undefined = update.sessionUpdate;

    switch (tag) {
      case 'agent_message_chunk': {
        const text = update.content?.text;
        if (typeof text === 'string') {
          sink({ type: 'text_delta', delta: text });
        }
        return;
      }
      case 'agent_thought_chunk': {
        const text = update.content?.text;
        if (typeof text === 'string') {
          sink({ type: 'thinking_delta', delta: text });
        }
        return;
      }
      case 'tool_call': {
        // ToolCallStart — rawInput is the tool input params
        const id = update.toolCallId;
        if (typeof id === 'string') {
          sink({
            type: 'tool_use',
            id,
            name: typeof update.title === 'string' ? update.title : '',
            input: update.rawInput ?? null,
          });
        }
        return;
      }
      case 'tool_call_update': {
        // ToolCallProgress — rawOutput is the tool result
        const id = update.toolCallId;
        if (typeof id === 'string') {
          const content = stringifyToolOutput(update.rawOutput);
          sink({
            type: 'tool_result',
            toolUseId: id,
            content,
            isError: update.status === 'failed',
          });
        }
        return;
      }
      case 'usage_update':
        // size/used are context-window stats, not turn token counts.
        // Turn-level usage comes from PromptResponse.usage — emitted by RunManager on turn_end.
        // Phase 1: ignore to avoid semantic confusion with UsageInfo.input_tokens/output_tokens.
        return;
      case 'available_commands_update':
      case 'session_info_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'plan':
      case 'user_message_chunk':
        // Phase 1: ignored non-turn notifications.
        return;
      default:
        // Unknown variant — surface as raw so we notice when the protocol grows.
        sink({ type: 'raw', line: JSON.stringify(update) });
    }
  }
}

/** Serialize a tool's rawOutput (any shape) into a flat string for the tool_result content. */
function stringifyToolOutput(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}
