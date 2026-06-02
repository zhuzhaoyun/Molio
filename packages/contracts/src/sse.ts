// ─── SSE transport types ───

import type { AgentEvent } from './event.js';

/**
 * Envelope wrapping each AgentEvent in the SSE stream.
 * `seq` is a monotonically increasing sequence number per run.
 */
export interface SSEEnvelope {
  seq: number;
  runId: string;
  event: AgentEvent;
}
