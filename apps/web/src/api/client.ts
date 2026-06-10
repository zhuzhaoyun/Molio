import type {
  AgentInfo, RunInfo, CreateRunRequest, ToolResultRequest,
  ChatMessage, Project, Conversation,
  Vault, TreeNode, FileContent, KbHistoryEntry, CreateVaultRequest,
  WikiStatusResponse, WikiBuildRequest, WikiIngestRequest,
  WikiLintRequest, WikiQueryRequest, WikiSaveRequest, WikiRunResponse,
} from '@molio/contracts';

const BASE = '/api';

export const api = {
  // ─── Agents ───

  async listAgents(): Promise<AgentInfo[]> {
    const res = await fetch(`${BASE}/agents`);
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
    const data = await res.json();
    return data.agents;
  },

  async testAgent(agentId: string): Promise<{ ok: boolean; elapsed: number; status?: string; error?: string }> {
    const res = await fetch(`${BASE}/agents/${agentId}/test`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json();
      return { ok: false, elapsed: data.elapsed ?? 0, error: data.error ?? `Test failed: ${res.status}` };
    }
    return res.json();
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

  async getConfig(): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/config`);
    if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
    return res.json();
  },

  async updateConfig(config: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${BASE}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`Failed to update config: ${res.status}`);
  },

  async getAgentConfig(agentId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/config/agents/${agentId}`);
    if (!res.ok) throw new Error(`Failed to fetch agent config: ${res.status}`);
    return res.json();
  },

  async updateAgentConfig(agentId: string, config: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${BASE}/config/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`Failed to update agent config: ${res.status}`);
  },

  // ─── Knowledge Base ───

  async listVaults(): Promise<Vault[]> {
    const res = await fetch(`${BASE}/knowledge/vaults`);
    if (!res.ok) throw new Error(`Failed to fetch vaults: ${res.status}`);
    const data = await res.json();
    return data.vaults;
  },

  async createVault(req: CreateVaultRequest): Promise<Vault> {
    const res = await fetch(`${BASE}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to create vault: ${res.status}`);
    }
    return res.json();
  },

  async deleteVault(id: string): Promise<void> {
    await fetch(`${BASE}/knowledge/vaults/${id}`, { method: 'DELETE' });
  },

  async getFileTree(vaultId: string): Promise<TreeNode[]> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/tree`);
    if (!res.ok) throw new Error(`Failed to fetch file tree: ${res.status}`);
    const data = await res.json();
    return data.tree;
  },

  async readFile(vaultId: string, filePath: string): Promise<FileContent> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/files/${encoded}`);
    if (!res.ok) throw new Error(`Failed to read file: ${res.status}`);
    return res.json();
  },

  /** Build URL for raw file access (images, PDFs, etc.) */
  rawFileUrl(vaultId: string, filePath: string): string {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    return `${BASE}/knowledge/vaults/${vaultId}/raw/${encoded}`;
  },

  async writeFile(vaultId: string, filePath: string, content: string): Promise<void> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/files/${encoded}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error(`Failed to write file: ${res.status}`);
  },

  async deleteFile(vaultId: string, filePath: string): Promise<void> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    await fetch(`${BASE}/knowledge/vaults/${vaultId}/files/${encoded}`, { method: 'DELETE' });
  },

  async createDirectory(vaultId: string, dirPath: string): Promise<void> {
    const encoded = encodeURIComponent(dirPath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/dirs/${encoded}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Failed to create directory: ${res.status}`);
  },

  async getKbHistory(vaultId: string, limit = 50): Promise<KbHistoryEntry[]> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/history?limit=${limit}`);
    if (!res.ok) throw new Error(`Failed to fetch history: ${res.status}`);
    const data = await res.json();
    return data.history;
  },

  // ─── Wiki ───

  async getWikiStatus(vaultId: string): Promise<WikiStatusResponse> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/wiki/status`);
    if (!res.ok) throw new Error(`Failed to fetch wiki status: ${res.status}`);
    return res.json();
  },

  async buildWiki(vaultId: string, req: WikiBuildRequest): Promise<WikiRunResponse> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/wiki/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to build wiki: ${res.status}`);
    }
    return res.json();
  },

  async ingestFile(vaultId: string, req: WikiIngestRequest): Promise<WikiRunResponse> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/wiki/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to ingest file: ${res.status}`);
    }
    return res.json();
  },

  async lintWiki(vaultId: string, req: WikiLintRequest): Promise<WikiRunResponse> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/wiki/lint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to lint wiki: ${res.status}`);
    }
    return res.json();
  },

  async queryWiki(vaultId: string, req: WikiQueryRequest): Promise<WikiRunResponse> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/wiki/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to query wiki: ${res.status}`);
    }
    return res.json();
  },

  async saveWiki(vaultId: string, req: WikiSaveRequest): Promise<WikiRunResponse> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/wiki/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to save wiki: ${res.status}`);
    }
    return res.json();
  },

  // ─── Publish ───

  async checkCose(): Promise<{ installed: boolean }> {
    const res = await fetch(`${BASE}/publish/check-cose`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to check COSE: ${res.status}`);
    return res.json();
  },

  async startPublish(data: {
    title: string;
    markdown: string;
    html: string;
    css: string;
  }): Promise<{ bridgeUrl: string }> {
    const res = await fetch(`${BASE}/publish/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to start publish: ${res.status}`);
    }
    return res.json();
  },

  // ─── Graph ───

  async getGraph(vaultId: string): Promise<{ nodes: { key: string; label: string; path: string; linkCount: number }[]; edges: { source: string; target: string }[] }> {
    const res = await fetch(`${BASE}/graph/${vaultId}`);
    if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
    return res.json();
  },
};
