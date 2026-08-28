import type {
  AgentInfo, InstallEvent, RunInfo, CreateRunRequest, ToolResultRequest,
  ChatMessage, Project, Conversation, ConversationHistoryItem,
  ConversationHistoryPage, ListHistoryQuery,
  Vault, TreeNode, FileContent, KbHistoryEntry, CreateVaultRequest,
  WikiStatusResponse,
  GraphData, SearchResult, SearchResponse,
  AuthStatus, SendCodeResponse, User, MeResponse,
  SkillManifestEntry, SkillDetailResponse, CreateSkillRequest, UpdateSkillRequest,
  ImportSkillRequest, PrefillResult,
  HubSkillsQuery, HubSkillsListResponse, HubCategoriesResponse,
  InstallHubSkillRequest, InstallHubSkillResponse,
  HubSkillDetailQuery, HubSkillDetailResponse,
} from '@molio/contracts';

/**
 * daemon /api/auth/* 错误的类型化包装。daemon 统一回 `{error: code, ...extra}`：
 * - 云端 4xx 原样透传（invalid_email / rate_limited+resendAfterSec / invalid_code / locked / mail_failed）
 * - 502 cloud_unreachable（断网）/ 503 auth_not_configured（MOLIO_AUTH_URL 显式置空白）
 * - 401 no_session（注销账号时无本地会话）
 * UI 按 code 映射文案（i18n），不按 status。
 */
export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(`auth: ${code} (${status})`);
    this.name = 'AuthApiError';
  }

  static async from(res: Response): Promise<AuthApiError> {
    let code = `http_${res.status}`;
    let extra: Record<string, unknown> = {};
    try {
      const body = (await res.json()) as Record<string, unknown> | null;
      if (body && typeof body === 'object') {
        if (typeof body.error === 'string') code = body.error;
        const { error: _dropped, ...rest } = body;
        extra = rest;
      }
    } catch {
      // 非 JSON 响应：保留 http_<status> code
    }
    return new AuthApiError(res.status, code, extra);
  }

  /** rate_limited 的重发等待秒数（云端透传） */
  get resendAfterSec(): number | null {
    return typeof this.extra.resendAfterSec === 'number' ? this.extra.resendAfterSec : null;
  }
}

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

export type FeishuLoginStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface FeishuStatus {
  enabled: boolean;
  loginStatus: FeishuLoginStatus;
  connected: boolean;
  lastError: string | null;
  lastMessageAt: number | null;
  activeRunId: string | null;
  hasCredentials: boolean;
  hasAppConfig: boolean;
  connectionState?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
}

export interface FeishuConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  baseUrl?: string;
  credentialsPath?: string;
  defaultAgentId?: string;
  defaultCwd?: string;
}

const BASE = '/api';

/**
 * /api/auth/* 统一 fetch 包装：非 2xx 一律抛 AuthApiError（UI 按 code 映射文案，
 * 见 components/account/authErrors.ts）。6 个 auth 端点共用，避免各自
 * `if (!res.ok)` 分支漂移。
 */
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}/auth/${path}`, init);
  if (!res.ok) throw await AuthApiError.from(res);
  return res;
}

const AUTH_JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

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

  async listConversationHistory(opts?: ListHistoryQuery): Promise<ConversationHistoryPage> {
    const params = new URLSearchParams();
    if (opts?.vaultId) params.set('vaultId', opts.vaultId);
    if (opts?.query) params.set('query', opts.query);
    if (opts?.before != null) params.set('before', String(opts.before));
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const res = await fetch(`${BASE}/conversations${qs ? `?${qs}` : ''}`);
    if (!res.ok) throw new Error(`Failed to fetch conversation history: ${res.status}`);
    return res.json();
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
    const res = await fetch(`${BASE}/conversations/${conversationId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message ?? `Failed to delete conversation: ${res.status}`);
    }
  },

  async updateConversation(
    conversationId: string,
    patch: { title?: string; pinned?: boolean },
  ): Promise<Conversation> {
    const res = await fetch(`${BASE}/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message ?? `Failed to update conversation: ${res.status}`);
    }
    return res.json();
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

  // ─── Feishu 自建应用 ───

  async getFeishuStatus(): Promise<FeishuStatus> {
    const res = await fetch(`${BASE}/feishu/status`);
    if (!res.ok) throw new Error(`Failed to fetch Feishu status: ${res.status}`);
    return res.json();
  },

  async updateFeishuConfig(config: FeishuConfig): Promise<FeishuStatus> {
    const res = await fetch(`${BASE}/feishu/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`Failed to update Feishu config: ${res.status}`);
    return res.json();
  },

  async startFeishu(): Promise<FeishuStatus> {
    const res = await fetch(`${BASE}/feishu/start`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to start Feishu: ${res.status}`);
    return res.json();
  },

  async stopFeishu(): Promise<FeishuStatus> {
    const res = await fetch(`${BASE}/feishu/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to stop Feishu: ${res.status}`);
    return res.json();
  },

  async disconnectFeishu(): Promise<FeishuStatus> {
    const res = await fetch(`${BASE}/feishu/disconnect`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to disconnect Feishu: ${res.status}`);
    return res.json();
  },

  // ─── Auth（云端账号；Web UI 一律经 daemon 本地镜像，设计 §五/§六） ───

  /** 登录态快照（daemon 不发网络请求；未配置云端时 configured=false）。 */
  async getAuthStatus(): Promise<AuthStatus> {
    return (await authFetch('status')).json();
  },

  /** 发送验证码。daemon 原样透传云端响应（daily/local 含 devCode，仅 E2E 用）。 */
  async authSendCode(email: string): Promise<SendCodeResponse> {
    const res = await authFetch('start', {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({ email }),
    });
    return res.json();
  },

  /** 验证码登录（注册=登录）；成功后 daemon 落盘 token。 */
  async authVerify(email: string, code: string): Promise<{ user: User; loggedIn: true }> {
    const res = await authFetch('verify', {
      method: 'POST',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({ email, code }),
    });
    return res.json();
  },

  /** 修改当前用户资料（第一期仅昵称）。成功后 daemon 已同步本地 token/权益快照。 */
  async authUpdateMe(nickname: string): Promise<MeResponse> {
    const res = await authFetch('me', {
      method: 'PATCH',
      headers: AUTH_JSON_HEADERS,
      body: JSON.stringify({ nickname }),
    });
    return res.json();
  },

  /** 本机登出：云端吊销尽力而为，本地必清。 */
  async authLogout(): Promise<void> {
    await authFetch('logout', { method: 'POST' });
  },

  /** 注销账号（个保法）：云端软删除 + 吊销全部 session。云端不可达会抛错且本地保留。 */
  async authDeleteAccount(): Promise<void> {
    await authFetch('account', { method: 'DELETE' });
  },

  // ─── Knowledge Base ───

  async listVaults(): Promise<Vault[]> {
    const res = await fetch(`${BASE}/knowledge/vaults`);
    if (!res.ok) throw new Error(`Failed to fetch vaults: ${res.status}`);
    const data = await res.json();
    return data.vaults;
  },

  /** 获取 vault 一级目录列表（发布页目录选择用；排除隐藏目录，.molio 除外） */
  async getTopDirs(vaultId: string): Promise<string[]> {
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/top-dirs`);
    if (!res.ok) throw new Error(`Failed to fetch top dirs: ${res.status}`);
    const data = await res.json();
    return data.dirs as string[];
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

  async readFile(vaultId: string, filePath: string, opts?: { force?: boolean }): Promise<FileContent> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const query = opts?.force ? '?force=1' : '';
    const res = await fetch(`${BASE}/knowledge/vaults/${vaultId}/files/${encoded}${query}`);
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

  // ─── Preload ───

  async getPreloadStatus(): Promise<Record<string, { status: string; progress?: number; message?: string; error?: string }>> {
    const res = await fetch(`${BASE}/preload/status`);
    if (!res.ok) throw new Error(`Failed to fetch preload status: ${res.status}`);
    const data = await res.json();
    return data.statuses;
  },

  /**
   * Start preloading skills. Returns a ReadableStream of SSE progress events.
   * Pass signal to allow cancellation.
   */
  async startPreload(
    skills: string[],
    onProgress: (event: { skill: string; status: string; progress: number; message: string }) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${BASE}/preload/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Preload start failed: ${res.status}` }));
      throw new Error(err.error ?? `Preload start failed: ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('No response stream');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            onProgress(event);
          } catch {
            // Skip malformed
          }
        }
      }
    }
  },

  async dismissPreload(skills: string[]): Promise<void> {
    const res = await fetch(`${BASE}/preload/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
    });
    if (!res.ok) throw new Error(`Failed to dismiss preload: ${res.status}`);
  },

  async undismissPreload(skills: string[]): Promise<void> {
    const res = await fetch(`${BASE}/preload/undismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
    });
    if (!res.ok) throw new Error(`Failed to undismiss preload: ${res.status}`);
  },

  /** Pause in-progress preloads, keeping partial artifacts for resume. */
  async pausePreload(skills: string[]): Promise<void> {
    const res = await fetch(`${BASE}/preload/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
    });
    if (!res.ok) throw new Error(`Failed to pause preload: ${res.status}`);
  },

  /** Stop preloads AND delete partial artifacts (clean reset to missing). */
  async stopPreload(skills: string[]): Promise<void> {
    const res = await fetch(`${BASE}/preload/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills }),
    });
    if (!res.ok) throw new Error(`Failed to stop preload: ${res.status}`);
  },

  // ─── Graph ───

  async getGraph(vaultId: string): Promise<GraphData> {
    const res = await fetch(`${BASE}/graph/${vaultId}`);
    if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
    return res.json();
  },

  // ─── Skills ───

  async listSkills(): Promise<SkillManifestEntry[]> {
    const res = await fetch(`${BASE}/skills`);
    if (!res.ok) throw new Error(`Failed to fetch skills: ${res.status}`);
    const data = await res.json();
    return data.skills;
  },

  /** Fetch one skill with its instructions body (for the edit form). */
  async getSkill(id: string): Promise<SkillDetailResponse> {
    const res = await fetch(`${BASE}/skills/${id}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to fetch skill: ${res.status}`);
    }
    return res.json();
  },

  async createSkill(req: CreateSkillRequest): Promise<SkillManifestEntry> {
    const res = await fetch(`${BASE}/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to create skill: ${res.status}`);
    }
    const data = await res.json();
    return data.skill;
  },

  async updateSkill(id: string, req: UpdateSkillRequest): Promise<SkillManifestEntry> {
    const res = await fetch(`${BASE}/skills/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to update skill: ${res.status}`);
    }
    const data = await res.json();
    return data.skill;
  },

  async toggleSkill(id: string, enabled: boolean): Promise<SkillManifestEntry> {
    const res = await fetch(`${BASE}/skills/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to toggle skill: ${res.status}`);
    }
    const data = await res.json();
    return data.skill;
  },

  async deleteSkill(id: string): Promise<void> {
    const res = await fetch(`${BASE}/skills/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to delete skill: ${res.status}`);
    }
  },

  async importSkill(req: ImportSkillRequest): Promise<SkillManifestEntry> {
    const res = await fetch(`${BASE}/skills/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to import skill: ${res.status}`);
    }
    const data = await res.json();
    return data.skill;
  },

  /** One-shot AI call to prefill a skill form. Always resolves (fallback flag set on failure). */
  async prefillSkill(content: string): Promise<PrefillResult> {
    const res = await fetch(`${BASE}/skills/prefill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? `Failed to prefill skill: ${res.status}`);
    }
    const data = await res.json();
    return data.prefill;
  },

  // ─── Skill hub (store) ───

  /** Browse/search the hub catalog (proxied by the daemon), with install state. */
  async listHubSkills(query: HubSkillsQuery = {}): Promise<HubSkillsListResponse> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
    if (query.category?.trim()) params.set('category', query.category.trim());
    if (query.sort && query.sort !== 'default') params.set('sort', query.sort);
    const qs = params.toString();
    const res = await fetch(`${BASE}/skills/hub/skills${qs ? `?${qs}` : ''}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to fetch hub skills: ${res.status}`);
    }
    return res.json();
  },

  /** One hub skill's detail (stats + SKILL.md readme + security verdicts). */
  async hubSkillDetail(query: HubSkillDetailQuery): Promise<HubSkillDetailResponse> {
    const params = new URLSearchParams({ slug: query.slug });
    if (query.namespace?.trim()) params.set('namespace', query.namespace.trim());
    const res = await fetch(`${BASE}/skills/hub/skill?${params.toString()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to fetch hub skill detail: ${res.status}`);
    }
    return res.json();
  },

  async hubCategories(): Promise<HubCategoriesResponse> {
    const res = await fetch(`${BASE}/skills/hub/categories`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to fetch hub categories: ${res.status}`);
    }
    return res.json();
  },

  /** Install (or refresh) a hub skill; the daemon downloads and imports it. */
  async installHubSkill(req: InstallHubSkillRequest): Promise<InstallHubSkillResponse> {
    const res = await fetch(`${BASE}/skills/hub/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Failed to install hub skill: ${res.status}`);
    }
    return res.json();
  },
};

