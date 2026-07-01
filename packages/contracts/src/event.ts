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
  | { type: 'models'; models: { id: string; label: string }[]; currentModelId?: string }
  | { type: 'raw'; line: string };

// ─── Stream handler interface ───

export interface StreamHandler {
  feed(chunk: string | Buffer): void;
  flush(): void;
}
