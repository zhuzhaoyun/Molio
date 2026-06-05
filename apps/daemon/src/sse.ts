import type { AgentEvent } from '@molio/contracts';
import type { RunManager } from './core/RunManager.js';
import type { BufferedEvent } from './types.js';

/**
 * Create a ReadableStream that emits SSE frames for a run's events.
 * Supports event replay: when afterId > 0, replays buffered events first.
 * If the run is already terminal, replays and closes immediately.
 */
export function createSSEStream(
  runManager: RunManager,
  runId: string,
  afterId: number = 0,
): { stream: ReadableStream<Uint8Array>; cleanup: () => void } {
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Phase 1: Replay buffered events with id > afterId
      const buffered = runManager.getBufferedEvents(runId, afterId);
      if (buffered) {
        for (const record of buffered) {
          const envelope = { seq: record.id, runId, event: record.data as AgentEvent };
          const frame = `id: ${record.id}\ndata: ${JSON.stringify(envelope)}\n\n`;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            return; // Stream closed during replay
          }
        }
      }

      // Phase 2: If run is already terminal, close the stream
      if (runManager.isTerminal(runId)) {
        try { controller.close(); } catch { /* already closed */ }
        return;
      }

      // Phase 3: Subscribe to live events
      unsub = runManager.onEvent(runId, (event: AgentEvent) => {
        const lastId = runManager.getLastEventId(runId);
        const envelope = { seq: lastId, runId, event };
        const frame = `id: ${lastId}\ndata: ${JSON.stringify(envelope)}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Stream may be closed
        }
      });

      // Keepalive ping every 15 seconds
      pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(':ping\n\n'));
        } catch {
          // Stream closed, cleanup will handle
        }
      }, 15_000);
    },
    cancel() {
      unsub?.();
      unsub = null;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    },
  });

  return {
    stream,
    cleanup: () => {
      unsub?.();
      unsub = null;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    },
  };
}
