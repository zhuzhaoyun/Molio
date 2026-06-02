/**
 * Internal daemon types — not part of the shared contracts.
 * RunState contains non-serializable fields (ChildProcess, Set).
 */
import type { ChildProcess } from 'node:child_process';
import type { AgentEvent, RunStatus } from '@kge/contracts';

export interface RunState {
  id: string;
  agentId: string;
  status: RunStatus;
  child: ChildProcess | null;
  stdinOpen: boolean;
  pendingHostAnswers: Set<string>;
  lastStopReason: string | null;
  eventListeners: Set<(event: AgentEvent) => void>;
  createdAt: number;
}
