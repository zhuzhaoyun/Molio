// ─── Unified event protocol ───

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  thought_tokens?: number;
  cached_read_tokens?: number;
  cached_write_tokens?: number;
}

/**
 * Live status of one background subagent / workflow worker, derived by the
 * daemon from the agent runtime's transcript files (not from the parent's
 * stream — the parent goes silent while background work runs).
 */
export interface SubagentActivity {
  /** Stable id: transcript basename (agent-<id>) or parent tool_use id. */
  id: string;
  /** Human label: subagent description, prompt head, or workflow name. */
  label: string;
  status: 'running' | 'done' | 'error';
  /** Last observed action, e.g. "Read transcode-x.txt" or "Write digest". */
  lastAction?: string;
  updatedAt: number;
  tokens?: number;
}

/** Snapshot of all background activity for a run. */
export interface ActivityInfo {
  /** True while the run has live background work. */
  active: boolean;
  agents: SubagentActivity[];
}

/**
 * Diagnostics from a Claude Code `system/api_retry` event — the CLI retries
 * failed API calls with exponential backoff (up to 10 attempts / ~3 min for
 * auth failures) while emitting one of these per attempt. Surfaced as a
 * `status` event with label='retrying' so consumers (runtimes test button,
 * chat UI) can show progress instead of a silent spinner.
 */
export interface ApiRetryInfo {
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  /** HTTP status of the failed API call (401/403 = auth, 429/5xx = transient). */
  errorStatus?: number;
  /** Provider error reason, e.g. "authentication_failed". */
  error?: string;
}

export type AgentEvent =
  | { type: 'status'; label: string; model?: string; ttftMs?: number; sessionId?: string;
      /** Present when label='retrying' (parsed from system/api_retry). */
      retry?: ApiRetryInfo }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; usage?: UsageInfo; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string; raw?: string }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'models'; models: { id: string; label: string }[]; currentModelId?: string }
  | { type: 'repairing'; message: string }
  | { type: 'activity'; activity: ActivityInfo }
  | { type: 'raw'; line: string };

// ─── Stream handler interface ───

export interface StreamHandler {
  feed(chunk: string | Buffer): void;
  flush(): void;
}
