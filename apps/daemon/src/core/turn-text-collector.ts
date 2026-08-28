/**
 * TurnTextCollector — accumulates text_delta fragments and tool events,
 * flushing the complete turn (text + tools snapshot) to a persistence
 * callback.
 *
 * Encapsulates the trim + empty-guard + try-catch logic that was
 * previously duplicated across emitEvent(), sendMessage(), and cancelRun().
 *
 * Tools persistence: RunManager feeds normalized tool_use / tool_result
 * events via addToolUse/addToolResult; flush() delivers a snapshot of the
 * assembled ToolEvent list alongside the turn text so the assistant message
 * can carry its own process record into messages.events_json. Snapshot +
 * clear on flush keeps multi-turn runs turn-scoped (each turn persists only
 * its own tools, not the whole run's history).
 */
export interface PersistedToolEvent {
  id: string;
  name: string;
  input: unknown;
  status: string;
  result?: string;
  isError?: boolean;
}

export class TurnTextCollector {
  private buffer = '';
  private pendingTools: PersistedToolEvent[] = [];
  private callback:
    | ((text: string, tools: PersistedToolEvent[], runId: string) => void)
    | null;
  private readonly runId: string;

  constructor(
    runId: string,
    callback?: (text: string, tools: PersistedToolEvent[], runId: string) => void,
  ) {
    this.runId = runId;
    this.callback = callback ?? null;
  }

  /** Append a text delta fragment to the current turn buffer. */
  append(delta: string): void {
    this.buffer += delta;
  }

  /** Record a tool_use — new entry, status pending until its result lands. */
  addToolUse(ev: { id?: string; name?: string; input?: unknown }): void {
    if (!ev.id) return;
    // Duplicate ids are overwritten in place (defensive; parsers dedupe upstream).
    const existing = this.pendingTools.find((t) => t.id === ev.id);
    if (existing) return;
    this.pendingTools.push({
      id: ev.id!,
      name: ev.name ?? 'unknown',
      input: ev.input ?? null,
      status: 'running',
    });
  }

  /**
   * Record a tool_result — fills the matching use entry (status/result/isError).
   * Orphan results (use never seen, e.g. resume-after-restart) are ignored.
   */
  addToolResult(ev: { toolUseId?: string; content?: string; isError?: boolean }): void {
    if (!ev.toolUseId) return;
    const target = [...this.pendingTools]
      .reverse()
      .find((t) => t.id === ev.toolUseId && t.status === 'running');
    if (!target) return;
    target.status = 'done';
    target.result = ev.content ?? '';
    target.isError = ev.isError === true ? true : undefined;
  }

  /**
   * Flush accumulated turn data to the callback.
   *
   * - Trims whitespace
   * - Skips turns with no text AND no tools (pure noise)
   * - Delivers a snapshot of pending tools, then clears them (turn-scoped)
   * - Wraps callback in try-catch (never throws)
   * - Returns true if data was actually delivered to the callback
   *
   * Idempotent: calling flush() multiple times without intervening
   * append()/addToolUse() is safe — subsequent calls return false.
   */
  flush(): boolean {
    const text = this.buffer.trim();
    this.buffer = '';
    const tools = this.pendingTools;
    this.pendingTools = [];

    if ((!text && tools.length === 0) || !this.callback) {
      return false;
    }

    try {
      this.callback(text, tools, this.runId);
    } catch {
      // Callback error (e.g. DB write failure) — swallow silently.
      // The data has already been cleared from the buffer.
    }

    return true;
  }

  /** Discard accumulated text and tools without invoking the callback. */
  reset(): void {
    this.buffer = '';
    this.pendingTools = [];
  }
}
