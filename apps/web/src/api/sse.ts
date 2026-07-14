import type { AgentEvent } from '@molio/contracts';

interface SSEEnvelope {
  seq: number;
  runId: string;
  event: AgentEvent;
}

/**
 * Diagnostic switch (devtools console): `window.__MOLIO_DEBUG_SSE_OPEN_SILENT__ = true`
 * Keeps the EventSource at readyState=OPEN (connection looks healthy) but drops every
 * inbound message — simulating "events never reach the upper layer" to verify whether
 * the idle fallback fires and how long it takes, WITHOUT waiting for a real 3h hang.
 * Production never sets this.
 */
const DEBUG_OPEN_SILENT = typeof window !== 'undefined'
  && (window as any).__MOLIO_DEBUG_SSE_OPEN_SILENT__ === true;

export function subscribeToRun(
  runId: string,
  onEvent: (event: AgentEvent, seq?: number) => void,
  onError?: (error: Event) => void,
  onDone?: () => void,
  afterSeq?: number,
  onKeepalive?: () => void,
): EventSource {
  // afterSeq > 0 → reconnect: ask daemon to replay buffered events with id > afterSeq
  // (events.ts:20 supports ?after=). Used by the watchdog to reconnect to the SAME run
  // after a dead connection, recovering missed events without losing session context.
  const url = afterSeq && afterSeq > 0
    ? `/api/runs/${runId}/events?after=${afterSeq}`
    : `/api/runs/${runId}/events`;
  const es = new EventSource(url);
  // Snapshot the switch at subscribe time so toggling mid-run doesn't half-apply.
  const openSilent = DEBUG_OPEN_SILENT
    || (typeof window !== 'undefined'
      && (window as any).__MOLIO_DEBUG_SSE_OPEN_SILENT__ === true);

  es.onmessage = (msg) => {
    // Diagnostic switch: drop every frame to simulate "events never reach the upper
    // layer" — including ping, so the watchdog eventually fires. Used to verify the
    // watchdog/reconnect path without waiting for a real 3h hang.
    if (openSilent) {
      console.warn('[sse] recv DROPPED (DEBUG_OPEN_SILENT) readyState=' + es.readyState);
      return;
    }
    // Ping is a `data: ping` frame (daemon sse.ts). Recognize before JSON.parse and
    // signal keepalive — this is the watchdog's heartbeat during turn gaps where no
    // real chat events flow but the connection is still alive.
    if (msg.data === 'ping') {
      onKeepalive?.();
      return;
    }
    try {
      const envelope: SSEEnvelope = JSON.parse(msg.data);
      console.debug('[sse] recv readyState=' + es.readyState + ' seq=' + envelope.seq + ' type=' + envelope.event.type);
      onEvent(envelope.event, envelope.seq);
    } catch {
      // Ignore parse errors for any non-JSON keepalive variant
    }
  };

  es.onerror = (err) => {
    console.warn('[sse] error readyState=' + es.readyState + ' runId=' + runId);
    onError?.(err);
    // If the daemon process exited (connection closed for good, not a
    // transient network blip), readyState is CLOSED. The browser's default
    // auto-reconnect would hammer /api/runs/:id/events forever with no
    // server to reach — close it and signal completion so the UI can
    // unlock the input. Transient failures (readyState still CONNECTING/
    // OPEN) keep the default reconnect behavior.
    if (es.readyState === EventSource.CLOSED) {
      console.warn('[sse] done (CLOSED) runId=' + runId);
      es.close();
      onDone?.();
    }
  };

  // Log open lifecycle once so we can see when a subscription is (re)established.
  console.debug('[sse] subscribe runId=' + runId + ' openSilent=' + openSilent);

  return es;
}
