/**
 * TurnTextCollector — accumulates text_delta fragments and flushes
 * complete turn text to a persistence callback.
 *
 * Encapsulates the trim + empty-guard + try-catch logic that was
 * previously duplicated across emitEvent(), sendMessage(), and cancelRun().
 */
export class TurnTextCollector {
  private buffer = '';
  private readonly callback: ((text: string, runId: string) => void) | null;
  private readonly runId: string;

  constructor(runId: string, callback?: (text: string, runId: string) => void) {
    this.runId = runId;
    this.callback = callback ?? null;
  }

  /** Append a text delta fragment to the current turn buffer. */
  append(delta: string): void {
    this.buffer += delta;
  }

  /**
   * Flush accumulated text to the callback.
   *
   * - Trims whitespace
   * - Skips empty results
   * - Wraps callback in try-catch (never throws)
   * - Clears buffer regardless of outcome
   * - Returns true if text was actually delivered to the callback
   *
   * Idempotent: calling flush() multiple times without intervening
   * append() is safe — subsequent calls return false.
   */
  flush(): boolean {
    const text = this.buffer.trim();
    this.buffer = '';

    if (!text || !this.callback) {
      return false;
    }

    try {
      this.callback(text, this.runId);
    } catch {
      // Callback error (e.g. DB write failure) — swallow silently.
      // The text has already been cleared from the buffer.
    }

    return true;
  }

  /** Discard accumulated text without invoking the callback. */
  reset(): void {
    this.buffer = '';
  }
}
