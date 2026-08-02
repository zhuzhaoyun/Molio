import type { AgentEvent } from '@molio/contracts';
import type { RunManager } from './core/RunManager.js';
import type { BufferedEvent } from './types.js';
import { dbgLog } from './core/debug-log.js';

/**
 * Fault-injection switch (env, default off): after N successful enqueues to the
 * SSE stream, start throwing on every subsequent enqueue. Because the existing
 * enqueue call sites wrap in try/catch that swallows errors, this reproduces
 * assumption 2 from the diagnosis ("daemon stream controller fails silently —
 * ping and events stop reaching the client, but daemon thinks it's still
 * sending"). Lets us verify in seconds whether this mechanism can produce the
 * "backend turn_end recorded, frontend got nothing" symptom, without waiting
 * 3h. Production never sets this.
 */
const DEBUG_BREAK_AFTER = Number(process.env.MOLIO_DEBUG_SSE_BREAK_AFTER) || 0;

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
  let enqueueCount = 0;
  // Backpressure: counts consecutive ping ticks where the consumer hasn't
  // drained the stream (desiredSize <= 0 — the client stopped reading, e.g.
  // a minimized/throttled renderer while a run keeps emitting). Previously
  // pings and live events were enqueued unconditionally, so a stalled client
  // made the daemon buffer the entire run's output in memory. After
  // MAX_STALLED_PINGS (≈60s at the 15s ping interval) we close the stream;
  // the client's EventSource auto-reconnects / watchdog re-subscribes with
  // ?after=<lastSeq> and the daemon replays buffered events — no data loss.
  // Test hook: MOLIO_TEST_SSE_STALL_TICKS lowers the tick count.
  const maxStalledTicks = Number(process.env.MOLIO_TEST_SSE_STALL_TICKS) || 4;
  let stalledTicks = 0;

  /** Whether the consumer is keeping up (safe to enqueue). */
  const consumerReady = (controller: ReadableStreamDefaultController<Uint8Array>): boolean =>
    controller.desiredSize !== null && controller.desiredSize > 0;

  /** Stop the subscription + ping timer. Idempotent — safe from cancel,
   * cleanup, AND the stall-close path. */
  const teardown = (): void => {
    unsub?.();
    unsub = null;
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  };

  // Wrap controller.enqueue so the fault-injection switch can simulate a dead
  // stream mid-connection. Throwing here is caught by the call-site try/catch,
  // mirroring how a real controller failure would be silently swallowed.
  const safeEnqueue = (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): boolean => {
    enqueueCount++;
    if (DEBUG_BREAK_AFTER > 0 && enqueueCount > DEBUG_BREAK_AFTER) {
      // Silent fail — caller's try/catch swallows, exactly like the real bug class.
      throw new Error(`DEBUG: SSE stream broken after ${DEBUG_BREAK_AFTER} enqueues (MOLIO_DEBUG_SSE_BREAK_AFTER)`);
    }
    controller.enqueue(bytes);
    return true;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      dbgLog(`stream start runId=${runId} after=${afterId} breakAfter=${DEBUG_BREAK_AFTER}`);

      // Phase 1: Replay buffered events with id > afterId
      const buffered = runManager.getBufferedEvents(runId, afterId);
      if (buffered) {
        for (const record of buffered) {
          const envelope = { seq: record.id, runId, event: record.data as AgentEvent };
          const frame = `id: ${record.id}\ndata: ${JSON.stringify(envelope)}\n\n`;
          try {
            safeEnqueue(controller, encoder.encode(frame));
          } catch {
            dbgLog(`replay enqueue FAILED (broken stream) runId=${runId} seq=${record.id}`);
            return; // Stream closed during replay
          }
        }
      }

      // Phase 2: If run is already terminal, close the stream
      if (runManager.isTerminal(runId)) {
        dbgLog(`stream close (terminal) runId=${runId}`);
        try { controller.close(); } catch { /* already closed */ }
        return;
      }

      // Phase 3: Subscribe to live events
      unsub = runManager.onEvent(runId, (event: AgentEvent) => {
        // Backpressure: skip enqueueing while the consumer is stalled. The
        // event stays in run.events (cap 2000) and is replayed when the
        // client reconnects — either via its own watchdog or the stall-close
        // below — so skipping here loses nothing.
        if (!consumerReady(controller)) return;
        const lastId = runManager.getLastEventId(runId);
        const envelope = { seq: lastId, runId, event };
        const frame = `id: ${lastId}\ndata: ${JSON.stringify(envelope)}\n\n`;
        try {
          safeEnqueue(controller, encoder.encode(frame));
        } catch {
          // Diagnostic: emitEvent fan-out reached this listener but enqueue failed —
          // the stream is dead. This is the smoking gun for assumption 2.
          dbgLog(`live event enqueue FAILED (broken stream) runId=${runId} seq=${lastId} type=${event.type}`);
          // Stream may be closed
        }
      });

      // Keepalive ping every 15 seconds. Sent as a `data:` frame (NOT an SSE
      // comment line `:ping`) so the browser's EventSource onmessage fires — the
      // frontend watchdog relies on receiving ping frames to tell "connection
      // alive but idle" from "connection dead". No `id:` line → not buffered in
      // run.events → replay won't flood the client with stale pings on reconnect.
      // Test hook: MOLIO_TEST_SSE_PING_MS shortens the interval so unit tests can
      // exercise the ping path without sleeping 15s. Production never sets it.
      const pingMs = Number(process.env.MOLIO_TEST_SSE_PING_MS) || 15_000;
      pingInterval = setInterval(() => {
        if (!consumerReady(controller)) {
          stalledTicks++;
          if (stalledTicks >= maxStalledTicks) {
            dbgLog(
              `stream stalled ${stalledTicks} ticks — client not reading, closing ` +
              `(client reconnect replays buffered events) runId=${runId}`,
            );
            teardown();
            try { controller.close(); } catch { /* already closed */ }
          }
          // A keepalive ping is worthless to a consumer that isn't reading —
          // never buffer it.
          return;
        }
        stalledTicks = 0;
        try {
          safeEnqueue(controller, encoder.encode('data: ping\n\n'));
        } catch {
          // Diagnostic: ping can't go out either — confirms the stream is dead from
          // the daemon side, not just a network issue.
          dbgLog(`ping enqueue FAILED runId=${runId} enqueueCount=${enqueueCount}`);
        }
      }, pingMs);
    },
    cancel() {
      dbgLog(`stream cancel runId=${runId}`);
      teardown();
    },
  });

  return {
    stream,
    cleanup: () => {
      dbgLog(`stream cleanup runId=${runId}`);
      teardown();
    },
  };
}
