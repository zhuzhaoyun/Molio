import type {
  AgentInfo, InstallEvent, RunInfo, CreateRunRequest, ToolResultRequest,
  ChatMessage, Project, Conversation, ConversationHistoryItem,
  Vault, TreeNode, FileContent, KbHistoryEntry, CreateVaultRequest,
  WikiStatusResponse,
  GraphData, SearchResult, SearchResponse,
} from '@molio/contracts';

export type WeixinLoginStatus = 'idle' | 'waiting_scan' | 'scanned' | 'logged_in' | 'error';

export interface WeixinStatus {
  enabled: boolean;
  loginStatus: WeixinLoginStatus;
  connected: boolean;
  qrcodeUrl: string;
  lastError: string | null;
  lastMessageAt: number | null;
  activeRunId: string | null;
  hasCredentials: boolean;
  connectionState?: 'idle' | 'connecting' | 'polling' | 'unhealthy' | 'expired';
}

export interface WeixinConfig {
  enabled?: boolean;
  baseUrl?: string;
  cdnBaseUrl?: string;
  credentialsPath?: string;
  defaultAgentId?: string;
  defaultCwd?: string;
}

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

  /**
   * Install an agent via SSE stream. Calls `onEvent` for each progress event.
   * Returns the final event (done or error).
   * Pass `signal` to allow cancellation (e.g. via AbortController).
   */
  async installAgent(
    agentId: string,
    onEvent: (event: InstallEvent) => void,
    signal?: AbortSignal,
  ): Promise<InstallEvent> {
    const res = await fetch(`${BASE}/agents/${agentId}/install`, {
      method: 'POST',
      signal,
    });
    if (!res.ok) {
      const data = await res.json();
      const errorEvent: InstallEvent = {
        type: 'error',
        message: data.error ?? `Install failed: ${res.status}`,
        category: 'unknown',
        retryable: true,
      };
      onEvent(errorEvent);
      return errorEvent;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const errorEvent: InstallEvent = {
        type: 'error',
        message: 'No response stream',
        category: 'unknown',
        retryable: false,
      };
      onEvent(errorEvent);
      return errorEvent;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let lastEvent: InstallEvent = { type: 'log', message: '' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: InstallEvent = JSON.parse(line.slice(6));
            onEvent(event);
            lastEvent = event;
          } catch {
            // Skip malformed SSE frames
          }
        }
      }
    }

    return lastEvent;
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

  async listConversationHistory(): Promise<ConversationHistoryItem[]> {
    const res = await fetch(`${BASE}/conversations`);
    if (!res.ok) throw new Error(`Failed to fetch conversation history: ${res.status}`);
    const data = await res.json();
    return data.conversations;
  },

  async getConversation(conversationId: string): Promise<Conversation> {
    const res = await fetch(`${BASE}/conversations/${conversationId}`);
    if (!res.ok) throw new Error(`Failed to fetch conversation: ${res.status}`);
    return res.json();
  },

  async listConversationMessages(conversationId: string): Promise<ChatMessage[]> {
    const res = await fetch(`${BASE}/conversations/${conversationId}/messages`);
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
    const data = await res.json();
    return data.messages;
  },

  async deleteConversationById(conversationId: string): Promise<void> {
    await fetch(`${BASE}/conversations/${conversationId}`, { method: 'DELETE' });
  },

  async rewindResend(conversationId: string, req: { newContent: string; agentId?: string; cwd?: string }): Promise<{ runId: string; conversationId: string }> {
    const res = await fetch(`${BASE}/conversations/${conversationId}/rewind-resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to rewind-resend: ${res.status}`);
    }
    return res.json();
  },

  async deleteMessages(conversationId: string, ids: string[]): Promise<{ deleted: number }> {
    const res = await fetch(`${BASE}/conversations/${conversationId}/delete-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to delete messages: ${res.status}`);
    }
    return res.json();
  },

  // ─── Weixin ClawBot ───

  async getWeixinStatus(): Promise<WeixinStatus> {
    const res = await fetch(`${BASE}/weixin/status`);
    if (!res.ok) throw new Error(`Failed to fetch Weixin status: ${res.status}`);
    return res.json();
  },

  async beginWeixinLogin(): Promise<WeixinStatus> {
    const res = await fetch(`${BASE}/weixin/login`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to start Weixin login: ${res.status}`);
    return res.json();
  },

  async updateWeixinConfig(config: WeixinConfig): Promise<WeixinStatus> {
    const res = await fetch(`${BASE}/weixin/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`Failed to update Weixin config: ${res.status}`);
    return res.json();
  },

  async disconnectWeixin(): Promise<WeixinStatus> {
    const res = await fetch(`${BASE}/weixin/disconnect`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to disconnect Weixin: ${res.status}`);
    return res.json();
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

  /** Returns the user's currently-active vault (the one external clippers target). */
  async getActiveVault(): Promise<{ vaultId: string | null; vault: (Vault & { fileCount: number }) | null }> {
    const res = await fetch(`${BASE}/knowledge/active-vault`);
    if (!res.ok) throw new Error(`Failed to fetch active vault: ${res.status}`);
    return res.json();
  },

  /** Set the active vault. Pass null to clear. Fire-and-forget safe. */
  async setActiveVault(id: string | null): Promise<void> {
    const res = await fetch(`${BASE}/knowledge/active-vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`Failed to set active vault: ${res.status}`);
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

  /**
   * Resolve a (possibly extension-less / wiki-prefix-less) file path to its
   * canonical vault-relative path with the real on-disk extension. Returns
   * null on 404 (no match); throws on other errors. Used when opening files
   * from assistant links / molio:// / graph so the tab title and tree highlight
   * match the real file.
   */
  async resolveFilePath(vaultId: string, filePath: string): Promise<string | null> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/resolve/${encoded}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to resolve file path: ${res.status}`);
    const data = await res.json();
    return data.path as string;
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

  /** Upload an image asset to the vault's .molio/assets/ directory. */
  async uploadAsset(vaultId: string, file: File): Promise<{ filePath: string; url: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/assets/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: `Upload failed: ${res.status}` } }));
      throw new Error(err.error?.message ?? `Upload failed: ${res.status}`);
    }
    return res.json();
  },

  /** Import files (upload) to a vault directory. */
  async importFiles(
    vaultId: string,
    files: File[],
    targetDir = '',
    conflict = 'ask',
  ): Promise<{
    imported: string[];
    renamed: Array<{ from: string; to: string }>;
    skipped: string[];
    errors: Array<{ file: string; reason: string }>;
    conflicts?: Array<{ file: string; reason: string }>;
  }> {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    if (targetDir) {
      formData.append('targetDir', targetDir);
    }
    formData.append('conflict', conflict);

    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/import`, {
      method: 'POST',
      body: formData,
    });
    // 409 = conflict: "ask" with conflicts — still valid JSON response
    if (!res.ok && res.status !== 409) {
      const err = await res.json().catch(() => ({ error: { message: `Import failed: ${res.status}` } }));
      throw new Error(err.error?.message ?? `Import failed: ${res.status}`);
    }
    return res.json();
  },

  async deleteFile(vaultId: string, filePath: string): Promise<void> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/files/${encoded}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message ?? `Failed to delete file: ${res.status}`);
    }
  },

  async renameFile(vaultId: string, oldPath: string, newPath: string): Promise<void> {
    const encoded = encodeURIComponent(oldPath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/files/${encoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPath }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to rename: ${res.status}`);
    }
  },

  async createDirectory(vaultId: string, dirPath: string): Promise<void> {
    const encoded = encodeURIComponent(dirPath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/dirs/${encoded}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`Failed to create directory: ${res.status}`);
  },

  async deleteDirectory(vaultId: string, dirPath: string): Promise<void> {
    const encoded = encodeURIComponent(dirPath).replace(/%2F/g, '/');
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/dirs/${encoded}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message ?? `Failed to delete directory: ${res.status}`);
    }
  },

  async getKbHistory(vaultId: string, limit = 50): Promise<KbHistoryEntry[]> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/history?limit=${limit}`);
    if (!res.ok) throw new Error(`Failed to fetch history: ${res.status}`);
    const data = await res.json();
    return data.history;
  },

  async searchFiles(vaultId: string, query: string, limit = 20): Promise<SearchResponse> {
    const res = await fetch(
      `${BASE}/knowledge/vaults/${vaultId}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`Failed to search: ${res.status}`);
    return res.json();
  },

  // ─── Wiki ───

  async getWikiStatus(vaultId: string): Promise<WikiStatusResponse> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/wiki/status`);
    if (!res.ok) throw new Error(`Failed to fetch wiki status: ${res.status}`);
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

  async getGraph(vaultId: string): Promise<GraphData> {
    const res = await fetch(`${BASE}/graph/${vaultId}`);
    if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
    return res.json();
  },
};
