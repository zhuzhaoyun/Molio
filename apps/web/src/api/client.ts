import type {
  AgentInfo, RunInfo, CreateRunRequest, ToolResultRequest,
  ChatMessage, Project, Conversation,
} from '@kge/contracts';

const BASE = '/api';

export const api = {
  // ─── Agents ───

  async listAgents(): Promise<AgentInfo[]> {
    const res = await fetch(`${BASE}/agents`);
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
    const data = await res.json();
    return data.agents;
  },

  // ─── Runs ───

  async createRun(req: CreateRunRequest): Promise<{ runId: string; conversationId?: string }> {
    const res = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to create run: ${res.status}`);
    }
    return res.json();
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

  // ─── Projects ───

  async listProjects(): Promise<Project[]> {
    const res = await fetch(`${BASE}/projects`);
    if (!res.ok) throw new Error(`Failed to fetch projects: ${res.status}`);
    const data = await res.json();
    return data.projects;
  },

  async createProject(name: string): Promise<Project> {
    const res = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Failed to create project: ${res.status}`);
    return res.json();
  },

  async deleteProject(id: string): Promise<void> {
    await fetch(`${BASE}/projects/${id}`, { method: 'DELETE' });
  },

  // ─── Conversations ───

  async listConversations(projectId: string): Promise<Conversation[]> {
    const res = await fetch(`${BASE}/projects/${projectId}/conversations`);
    if (!res.ok) throw new Error(`Failed to fetch conversations: ${res.status}`);
    const data = await res.json();
    return data.conversations;
  },

  async createConversation(projectId: string, title?: string): Promise<Conversation> {
    const res = await fetch(`${BASE}/projects/${projectId}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`Failed to create conversation: ${res.status}`);
    return res.json();
  },

  async deleteConversation(projectId: string, conversationId: string): Promise<void> {
    await fetch(`${BASE}/projects/${projectId}/conversations/${conversationId}`, {
      method: 'DELETE',
    });
  },

  // ─── Messages ───

  async listMessages(projectId: string, conversationId: string): Promise<ChatMessage[]> {
    const res = await fetch(`${BASE}/projects/${projectId}/conversations/${conversationId}/messages`);
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
    const data = await res.json();
    return data.messages;
  },

  async saveMessage(projectId: string, conversationId: string, message: ChatMessage): Promise<void> {
    const res = await fetch(
      `${BASE}/projects/${projectId}/conversations/${conversationId}/messages/${message.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      },
    );
    if (!res.ok) throw new Error(`Failed to save message: ${res.status}`);
  },

  // ─── Config ───

  async getConfig() {
    const res = await fetch(`${BASE}/config`);
    return res.json();
  },
};
