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
 * Lifecycle: 1 AcpTransport instance = 1 long-running agent process = 1 ACP session.
 * The transport is owned by RunState.acp; RunManager constructs it after spawn and
 * drives initialize / session/new / session/prompt / session/cancel through it.
 *
 * Turn boundary: `session/prompt` is a request — its Promise resolution IS the turn
 * end (stopReason comes from PromptResponse). session/update notifications streamed
 * during the await are mapped to AgentEvents and emitted via onEvent.
 *
 * ── Activity-based timeouts ──
 *
 * `request()` uses an **idle** timer, not an absolute deadline. The idle timer
 * resets whenever the agent produces output (stdout via `feed()` or stderr via
 * `noteActivity()`). This adapts to slow cold starts: as long as the agent is
 * still printing (loading plugins, connecting providers), the request stays
 * pending. Only a truly hung agent (no output for `idleTimeoutMs`) times out.
 * An `absoluteTimeoutMs` safety-net cap is also enforced.
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
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  absoluteTimer?: ReturnType<typeof setTimeout>;
  idleTimeoutMs?: number;
  method: string;
}

export class AcpTransport {
  /** Cap stdout buffer to prevent unbounded growth from malformed/large payloads. */
  private static readonly MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB

  private buffer = '';
  private pending = new Map<number, PendingEntry>();
  private nextId = 1;
  private cancelledSessionIds = new Set<string>();

  constructor(
    /** Writes a complete JSON-RPC frame (including trailing newline) to the agent's stdin. */
    private readonly send: (json: string) => void,
    /** Emits a mapped Molio AgentEvent. */
    private readonly onEvent: (ev: AgentEvent) => void,
  ) {}

  /** Feed a chunk of stdout (string or Buffer) — splits newline-delimited JSON frames. */
  feed(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Any stdout data counts as activity — reset idle timers before parsing.
    this.noteActivity();
    if (this.buffer.length > AcpTransport.MAX_BUFFER_SIZE) {
      // Drop everything and surface as a raw event so it isn't silently lost.
      // Continuing to parse a 10MB+ partial frame risks OOM and is almost
      // certainly garbage (binary data, malformed JSON, or a hostile payload).
      const dropped = this.buffer.length;
      this.buffer = '';
      this.onEvent({
        type: 'raw',
        line: `[AcpTransport buffer overflow — dropped ${dropped} bytes without a newline]`,
      });
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
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
   */
  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    const id = this.nextId++;
    const { idleTimeoutMs, absoluteTimeoutMs } = options;
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        method,
        idleTimeoutMs,
      };

      if (idleTimeoutMs !== undefined) {
        entry.idleTimer = this.armIdleTimer(id, entry, method, idleTimeoutMs);
      }
      if (absoluteTimeoutMs !== undefined) {
        entry.absoluteTimer = setTimeout(() => {
          if (this.pending.delete(id)) {
            this.clearEntryTimers(entry);
            reject(new Error(`ACP absolute timeout: ${method} (${absoluteTimeoutMs}ms)`));
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
   * RunManager's stderr handler).
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

  /** Reject all pending requests — call when the child process exits unexpectedly. */
  rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      this.clearEntryTimers(entry);
      entry.reject(error);
    }
    this.pending.clear();
    // No further session/update notifications can arrive — drop the cancelled
    // markers so the set doesn't accumulate stale entries across re-used runs.
    this.cancelledSessionIds.clear();
  }

  /** Test/inspection: are there any in-flight requests? Used by RunManager to
   *  decide whether a process exit was a mid-prompt crash or a clean shutdown. */
  hasPending(): boolean {
    return this.pending.size > 0;
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
      // Not valid JSON — surface as a raw event so it isn't silently lost.
      this.onEvent({ type: 'raw', line });
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

    // Notification from agent
    if (msg.method === 'session/update' && msg.params) {
      const sessionId: string | undefined = msg.params.sessionId;
      if (sessionId && this.cancelledSessionIds.has(sessionId)) return;
      this.mapUpdate(msg.params.update);
      return;
    }

    // Other notifications / server-initiated requests (e.g. session/request_permission)
    // Phase 1: ignore. Phase 2 will handle permission requests.
  }

  private mapUpdate(update: any): void {
    if (!update || typeof update !== 'object') return;
    const tag: string | undefined = update.sessionUpdate;

    switch (tag) {
      case 'agent_message_chunk': {
        const text = update.content?.text;
        if (typeof text === 'string') {
          this.onEvent({ type: 'text_delta', delta: text });
        }
        return;
      }
      case 'agent_thought_chunk': {
        const text = update.content?.text;
        if (typeof text === 'string') {
          this.onEvent({ type: 'thinking_delta', delta: text });
        }
        return;
      }
      case 'tool_call': {
        // ToolCallStart — rawInput is the tool input params
        const id = update.toolCallId;
        if (typeof id === 'string') {
          this.onEvent({
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
          this.onEvent({
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
        this.onEvent({ type: 'raw', line: JSON.stringify(update) });
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
