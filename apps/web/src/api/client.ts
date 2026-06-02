import type { AgentInfo, RunInfo, CreateRunRequest, ToolResultRequest } from '@kge/contracts';

const BASE = '/api';

export const api = {
  async listAgents(): Promise<AgentInfo[]> {
    const res = await fetch(`${BASE}/agents`);
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
    const data = await res.json();
    return data.agents;
  },

  async createRun(req: CreateRunRequest): Promise<string> {
    const res = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to create run: ${res.status}`);
    }
    const data = await res.json();
    return data.runId;
  },

  async listRuns(): Promise<RunInfo[]> {
    const res = await fetch(`${BASE}/runs`);
    if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
    const data = await res.json();
    return data.runs;
  },

  async getRun(runId: string): Promise<RunInfo> {
    const res = await fetch(`${BASE}/runs/${runId}`);
    if (!res.ok) throw new Error(`Run not found: ${runId}`);
    return res.json();
  },

  async cancelRun(runId: string): Promise<void> {
    await fetch(`${BASE}/runs/${runId}`, { method: 'DELETE' });
  },

  async sendMessage(runId: string, message: string): Promise<void> {
    const res = await fetch(`${BASE}/runs/${runId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? 'Failed to send message');
    }
  },

  async submitToolResult(runId: string, req: ToolResultRequest): Promise<void> {
    const res = await fetch(`${BASE}/runs/${runId}/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? 'Failed to submit tool result');
    }
  },

  async getConfig() {
    const res = await fetch(`${BASE}/config`);
    return res.json();
  },
};
