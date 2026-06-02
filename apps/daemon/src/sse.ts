import type { AgentEvent } from '@kge/contracts';
import type { RunManager } from './core/RunManager.js';

/**
 * Create a ReadableStream that emits SSE frames for a run's events.
 * Subscribes to RunManager.onEvent and formats each event as an SSE envelope.
 */
export function createSSEStream(
  runManager: RunManager,
  runId: string,
): { stream: ReadableStream<Uint8Array>; cleanup: () => void } {
  const encoder = new TextEncoder();
  let seq = 0;
  let unsub: (() => void) | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsub = runManager.onEvent(runId, (event: AgentEvent) => {
        const envelope = { seq: seq++, runId, event };
        const frame = `data: ${JSON.stringify(envelope)}\n\n`;
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
