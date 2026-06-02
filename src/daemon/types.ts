import type { ChildProcess } from 'node:child_process';

// ─── Runtime definition ───

export interface RuntimeModelOption {
  id: string;
  label: string;
}

export interface RuntimeBuildOptions {
  model?: string | null;
}

export interface RuntimeContext {
  cwd?: string;
}

/**
 * The central abstraction. Every supported AI runtime is one object
 * conforming to this interface. Pure data + one function (buildArgs).
 */
export interface RuntimeAgentDef {
  id: string;
  name: string;
  bin: string;
  fallbackBins?: string[];
  versionArgs: string[];
  versionProbeTimeoutMs?: number;

  buildArgs: (
    prompt: string,
    options?: RuntimeBuildOptions,
    runtimeContext?: RuntimeContext,
  ) => string[];

  streamFormat: string;
  eventParser?: string;

  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';

  fallbackModels: RuntimeModelOption[];

  env?: Record<string, string>;

  installUrl?: string;
}

// ─── Unified event protocol ───

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  thought_tokens?: number;
  cached_read_tokens?: number;
  cached_write_tokens?: number;
}

export type AgentEvent =
  | { type: 'status'; label: string; model?: string; ttftMs?: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; usage?: UsageInfo; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string; raw?: string }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'raw'; line: string };

// ─── Stream handler interface ───

export interface StreamHandler {
  feed(chunk: string | Buffer): void;
  flush(): void;
}

// ─── Run state (in-memory) ───

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

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

// ─── Agent info (for listing) ───

export interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
  version?: string | null;
  models: RuntimeModelOption[];
  installUrl?: string;
}
