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

  /**
   * Seq of the last event actually delivered to this consumer. Phase 1 replay
   * and live enqueues advance it; events the backpressure gate skips while the
   * consumer is stalled DON'T advance it, so `pull()` can replay the gap from
   * the run buffer once the consumer drains. Without this, a resume/reconnect
   * connection that replays a burst then loses the live tail (agent emitting
   * while the client is still draining the replay) would silently truncate the
   * reply — the daemon-side root cause of "切页返回后只有当前显示的会话在继续".
   */
  let lastDeliveredId = afterId;

  /** Whether the consumer is keeping up (safe to enqueue). */
  const consumerReady = (controller: ReadableStreamDefaultController<Uint8Array>): boolean =>
    controller.desiredSize !== null && controller.desiredSize > 0;

  /** Encode an SSE frame for a buffered/live event. */
  const frameFor = (seq: number, event: AgentEvent): Uint8Array =>
    encoder.encode(`id: ${seq}\ndata: ${JSON.stringify({ seq, runId, event })}\n\n`);

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
          try {
            safeEnqueue(controller, frameFor(record.id, record.data as AgentEvent));
            lastDeliveredId = record.id;
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
        const lastId = runManager.getLastEventId(runId);
        // Backpressure: skip enqueueing while the consumer is stalled. The
        // event stays in run.events (cap 2000) and is replayed when the
        // client reconnects — either via its own watchdog or the stall-close
        // below — so skipping here loses nothing.
        if (!consumerReady(controller)) return;
        // If the consumer stalled mid-stream, events were skipped and the
        // delivery seq has a gap. Enqueueing this event directly would jump
        // lastDeliveredId past the skipped ones — leaving them unrecoverable.
        // Leave the whole gap to pull(), which replays it in order from the
        // run buffer once the consumer drains.
        if (lastId > lastDeliveredId + 1) return;
        // Advance lastDeliveredId BEFORE enqueueing. controller.enqueue() is
        // re-entrant: when the consumer has a pending read() (a live renderer
        // almost always does), Node fulfills that read from the chunk, sees
        // desiredSize > 0, and SYNCHRONOUSLY calls pull() — while this callback
        // is still mid-flight. Advancing first makes that re-entrant pull() see
        // lastDeliveredId === getLastEventId() and skip, instead of replaying
        // the very event we're delivering and sending the same frame twice (the
        // v0.3.42 "duplicated assistant reply" bug). If enqueue throws, the
        // stream is dead; the event is still in run.events and a reconnect
        // (client ?after=<its last RECEIVED seq>) replays it — the daemon's
        // lastDeliveredId on a dead stream never feeds a reconnect, so the
        // advance cannot cause data loss here.
        lastDeliveredId = lastId;
        try {
          safeEnqueue(controller, frameFor(lastId, event));
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
    // The consumer drained the queue (a read completed, desiredSize recovered).
    // Replay anything the backpressure gate skipped while it was stalled. The
    // pace is bounded by consumerReady — one frame fits (HWM 1), then pull is
    // re-invoked as the consumer reads on, so a genuinely stalled consumer
    // never accumulates an unbounded controller queue (that's what the
    // stall-close below guards).
    pull(controller) {
      if (!consumerReady(controller)) return;
      if (lastDeliveredId >= runManager.getLastEventId(runId)) return; // nothing missed
      const missed = runManager.getBufferedEvents(runId, lastDeliveredId);
      if (!missed) return;
      for (const record of missed) {
        if (!consumerReady(controller)) break; // queue full again — pace to next pull
        try {
          safeEnqueue(controller, frameFor(record.id, record.data as AgentEvent));
          lastDeliveredId = record.id;
        } catch {
          return; // stream dead mid-flush
        }
      }
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
