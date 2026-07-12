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
  onEvent: (event: AgentEvent) => void,
  onError?: (error: Event) => void,
  onDone?: () => void,
): EventSource {
  const es = new EventSource(`/api/runs/${runId}/events`);
  // Snapshot the switch at subscribe time so toggling mid-run doesn't half-apply.
  const openSilent = DEBUG_OPEN_SILENT
    || (typeof window !== 'undefined'
      && (window as any).__MOLIO_DEBUG_SSE_OPEN_SILENT__ === true);

  es.onmessage = (msg) => {
    // Diagnostic: confirm frames are reaching the browser. Pings (`:ping`) are SSE
    // comment lines and do NOT trigger onmessage, so any log here is a real event frame.
    if (openSilent) {
      console.warn('[sse] recv DROPPED (DEBUG_OPEN_SILENT) readyState=' + es.readyState);
      return;
    }
    try {
      const envelope: SSEEnvelope = JSON.parse(msg.data);
      console.debug('[sse] recv readyState=' + es.readyState + ' seq=' + envelope.seq + ' type=' + envelope.event.type);
      onEvent(envelope.event);
    } catch {
      // Ignore parse errors for keepalive pings
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
