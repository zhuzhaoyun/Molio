// ─── Run types (API-safe, serializable) ───

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * Serializable run info for API responses.
 * Does NOT contain ChildProcess, Set, or other non-serializable fields.
 * The internal RunState (with child process handles) lives in the daemon only.
 */
export interface RunInfo {
  id: string;
  agentId: string;
  status: RunStatus;
  createdAt: number;
  lastStopReason: string | null;
}
