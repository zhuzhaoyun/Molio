/**
 * Internal daemon types — not part of the shared contracts.
 * RunState contains non-serializable fields (ChildProcess, Set).
 */
import type { ChildProcess } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import type { AgentEvent, RunStatus } from '@molio/contracts';
import type { TurnTextCollector } from './core/turn-text-collector.js';

/**
 * Buffered event record for SSE replay.
 * Events are stored in run.events[] and optionally persisted to JSONL.
 */
export interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
  timestamp: number;
}

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

  // --- Phase 1: Event Buffer + SSE Replay ---
  projectId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  events: BufferedEvent[];
  nextEventId: number;
  eventsLogPath: string | null;
  eventsLogStream: WriteStream | null;
  updatedAt: number;
  exitCode: number | null;
  error: string | null;
  errorCode: string | null;

  // --- Turn-complete persistence ---
  /** Manages per-turn text accumulation and persistence. */
  turnText: TurnTextCollector;
}
