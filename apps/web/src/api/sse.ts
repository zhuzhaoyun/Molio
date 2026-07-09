import type { AgentEvent } from '@molio/contracts';

interface SSEEnvelope {
  seq: number;
  runId: string;
  event: AgentEvent;
}

export function subscribeToRun(
  runId: string,
  onEvent: (event: AgentEvent) => void,
  onError?: (error: Event) => void,
  onDone?: () => void,
): EventSource {
  const es = new EventSource(`/api/runs/${runId}/events`);

  es.onmessage = (msg) => {
    try {
      const envelope: SSEEnvelope = JSON.parse(msg.data);
      onEvent(envelope.event);
    } catch {
      // Ignore parse errors for keepalive pings
    }
  };

  es.onerror = (err) => {
    onError?.(err);
    // If the daemon process exited (connection closed for good, not a
    // transient network blip), readyState is CLOSED. The browser's default
    // auto-reconnect would hammer /api/runs/:id/events forever with no
    // server to reach — close it and signal completion so the UI can
    // unlock the input. Transient failures (readyState still CONNECTING/
    // OPEN) keep the default reconnect behavior.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      onDone?.();
    }
  };

  return es;
}
