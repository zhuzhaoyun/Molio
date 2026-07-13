/**
 * Internal daemon types — not part of the shared contracts.
 * RunState contains non-serializable fields (ChildProcess, Set).
 */
import type { ChildProcess } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import type { AgentEvent, RunStatus } from '@molio/contracts';
import type { TurnTextCollector } from './core/turn-text-collector.js';
import type { AcpTransport } from './core/streams/acp-transport.js';

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

/**
 * ACP-specific state for runs using transport: 'acp-jsonrpc'.
 * 1 Molio run = 1 AcpTransport = 1 ACP session = 1 long-running agent process.
 */
export interface RunAcpState {
  transport: AcpTransport;
  sessionId: string;
}

/**
 * Model entry returned by `session/new` (ACP agents like Hermes).
 * Replaces the static `fallbackModels` list after the first run initializes.
 */
export interface AcpModelOption {
  modelId: string;
  name: string;
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

  // --- ACP (Hermes) state ---
  /** Present only when the agent uses transport: 'acp-jsonrpc'. */
  acp?: RunAcpState;
  /** Models returned by session/new; pushed to frontend via SSE to replace fallbackModels. */
  acpModels?: AcpModelOption[];
  /** Last non-empty stderr line from the agent process — surfaced in idle/absolute
   *  timeout error messages so reporters can share what hermes logged right
   *  before going silent, without needing to find the JSONL log. */
  lastStderrLine?: string;
  /** Absolute path of the spawned agent binary — surfaced in init/prompt failure
   *  errors so users can compare it against `where <agent>` output from terminal
   *  and immediately spot "Molio found the wrong install" cases. */
  binaryPath?: string;
}
