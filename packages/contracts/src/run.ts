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
  error?: string | null;
  /** 所属会话。null = 非会话型 run（如 agent 测试）。KB 会话重挂载时用它定位活跃 run 并恢复直播流。 */
  conversationId: string | null;
}
