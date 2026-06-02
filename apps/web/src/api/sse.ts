import type { AgentEvent } from '@kge/contracts';

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
    // EventSource auto-reconnects by default
  };

  // Listen for close via status changes
  // The server sends an 'end' event through the agent events
  // which the consumer can detect

  return es;
}
