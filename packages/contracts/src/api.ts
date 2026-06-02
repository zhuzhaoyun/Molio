// ─── REST API types ───

export interface CreateRunRequest {
  agentId: string;
  message: string;
  model?: string;
  cwd?: string;
}

export interface CreateRunResponse {
  runId: string;
}

export interface ToolResultRequest {
  toolUseId: string;
  content: string;
}

export interface AgentListResponse {
  agents: import('./agent.js').AgentInfo[];
}

export interface RunListResponse {
  runs: import('./run.js').RunInfo[];
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
