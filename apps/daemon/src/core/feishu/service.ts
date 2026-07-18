import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RunManager } from '../RunManager.js';
import type { ConversationService } from '../conversations/service.js';
import { loadConfig, saveConfig, type FeishuConfig } from '../config.js';
import { ChannelDispatcher } from '../channels/dispatcher.js';
import type { ChannelSink } from '../channels/types.js';
import { getVaultByPath } from '../db.js';
import { FEISHU_SYS_PROMPT_FILE } from '../wiki-prompts.js';
import { DEFAULT_BASE_URL, FeishuApi } from './client.js';
import { FeishuWSClient } from './ws-client.js';
import { buildFeishuPrompt, parseFeishuMessage } from './message.js';
import { materializeFeishuAttachments } from './media.js';
import type {
  FeishuAttachment,
  FeishuCredentials,
  FeishuRawEvent,
  FeishuStatus,
  ParsedFeishuMessage,
} from './types.js';
import type { ConnectionState } from '../channels/types.js';
import type { OutboundMediaItem } from '../channels/types.js';

/** Refresh cadence: tenant_access_token is 2h valid; refresh at ~100min. */
const TOKEN_REFRESH_INTERVAL_MS = 100 * 60 * 1000;
/** Dedup window for received message_id (matches weixin). */
const DEDUP_TTL_MS = 7 * 60 * 60 * 1000;
/** Hard cap on the dedup map so a quiet-but-long-lived process can't leak
 * memory indefinitely. 7h TTL means ~10k entries at 1 msg/s sustained. */
const DEDUP_MAX_ENTRIES = 10_000;
/** Chunk size for sendText — Feishu's text limit is 4096 bytes; use 3000 chars for safety. */
const TEXT_CHUNK_LIMIT = 3000;

function configDir(): string {
  return path.join(os.homedir(), '.molio');
}

function defaultCredentialsPath(): string {
  return path.join(configDir(), 'feishu-credentials.json');
}

function resolveCredentialsPath(config?: FeishuConfig): string {
  const configured = config?.credentialsPath;
  if (!configured) return defaultCredentialsPath();
  if (configured.startsWith('~')) return path.join(os.homedir(), configured.slice(1));
  return configured;
}

function readCredentials(file: string): FeishuCredentials | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FeishuCredentials>;
    if (typeof parsed.tenantAccessToken !== 'string' || !parsed.tenantAccessToken) return null;
    if (typeof parsed.expiresAt !== 'number' || !parsed.expiresAt) return null;
    return { tenantAccessToken: parsed.tenantAccessToken, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function writeCredentials(file: string, credentials: FeishuCredentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows / non-POSIX filesystems ignore chmod.
  }
  fs.renameSync(tmp, file);
}

function removeCredentials(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

/** Resolve the feishu-specific wiki system-prompt file for a fresh spawn. */
function wikiPromptFileFor(
  db: Database.Database | undefined,
  cwd: string | undefined,
): string | undefined {
  if (!db || !cwd) return undefined;
  const vault = getVaultByPath(db, cwd);
  return vault ? FEISHU_SYS_PROMPT_FILE : undefined;
}

export class FeishuService implements ChannelSink {
  private api: FeishuApi | null = null;
  private wsClient: FeishuWSClient | null = null;
  private connectionState: ConnectionState = 'idle';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private receivedMessageIds = new Map<string, number>();
  /** Cached tenant_access_token + expiry (lives in-memory + on-disk). */
  private cachedToken: FeishuCredentials | null = null;
  /** Multi-turn run reuse state machine (per-user run/queue/drain). */
  private readonly dispatcher: ChannelDispatcher;
  private status: FeishuStatus = {
    enabled: false,
    loginStatus: 'idle',
    connected: false,
    lastError: null,
    lastMessageAt: null,
    activeRunId: null,
    hasCredentials: false,
    hasAppConfig: false,
    connectionState: 'idle',
  };

  constructor(
    private readonly runManager: RunManager,
    private readonly conversations: ConversationService,
    private readonly db?: Database.Database,
  ) {
    this.dispatcher = new ChannelDispatcher({
      runManager,
      conversations,
      db,
      sink: this,
      wikiPromptFileFor,
      buildPrompt: buildFeishuPrompt,
      channelLabel: 'feishu',
    });
  }

  getStatus(): FeishuStatus {
    const cfg = this.getConfig();
    const credentialsPath = resolveCredentialsPath(cfg);
    return {
      ...this.status,
      enabled: !!cfg.enabled,
      hasCredentials: fs.existsSync(credentialsPath),
      hasAppConfig: !!(cfg.appId && cfg.appSecret),
      connectionState: this.connectionState,
    };
  }

  async updateConfig(next: FeishuConfig): Promise<FeishuStatus> {
    const config = loadConfig();
    config.feishu = {
      ...(config.feishu ?? {}),
      ...next,
    };
    saveConfig(config);

    // App identity changed — invalidate the cached token (the old token is for
    // a different app) and tear down any live WS connection so start() can
    // re-establish with the new identity.
    if (next.appId !== undefined || next.appSecret !== undefined) {
      removeCredentials(resolveCredentialsPath(config.feishu));
      this.cachedToken = null;
      await this.stopWSClient();
    }

    if (config.feishu.enabled) {
      await this.start();
    } else {
      await this.stop();
    }

    return this.getStatus();
  }

  async start(): Promise<FeishuStatus> {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.status.enabled = false;
      return this.getStatus();
    }
    if (!cfg.appId || !cfg.appSecret) {
      this.transitionTo('idle');
      this.status.loginStatus = 'idle';
      this.status.connected = false;
      this.status.lastError = '缺少 appId/appSecret，请在飞书开放平台创建自建应用后填入。';
      return this.getStatus();
    }

    // Already connected — let it continue.
    if (this.connectionState === 'connected' && this.wsClient) return this.getStatus();
    if (this.connectionState === 'connecting') return this.getStatus();

    this.transitionTo('connecting');
    this.status.loginStatus = 'connecting';
    this.status.connected = false;
    this.status.lastError = null;

    this.api = new FeishuApi(cfg.baseUrl || DEFAULT_BASE_URL, cfg.appId, cfg.appSecret);

    // Try to load a cached token; if it's stale, refresh now (proves creds work).
    try {
      await this.ensureToken();
    } catch (err) {
      this.transitionTo('error');
      this.status.loginStatus = 'error';
      this.status.lastError = `Token 获取失败：${err instanceof Error ? err.message : String(err)}`;
      return this.getStatus();
    }

    // Start the WS long-connection. SDK handles reconnect/ping.
    await this.startWSClient();
    this.startTokenRefresh();
    return this.getStatus();
  }

  async stop(): Promise<FeishuStatus> {
    this.stopTokenRefresh();
    await this.stopWSClient();
    this.dispatcher.cancelAll();
    this.api = null;
    this.cachedToken = null;
    this.transitionTo('idle');
    this.status = {
      ...this.status,
      loginStatus: 'idle',
      connected: false,
      lastError: null,
    };
    return this.getStatus();
  }

  async disconnect(): Promise<FeishuStatus> {
    await this.stop();
    removeCredentials(resolveCredentialsPath(this.getConfig()));
    const config = loadConfig();
    config.feishu = {
      ...(config.feishu ?? {}),
      enabled: false,
    };
    saveConfig(config);
    return this.getStatus();
  }

  // ----- token management -------------------------------------------------

  /**
   * Return a usable tenant_access_token, refreshing if the cached one is
   * expired or about to expire. Throws if refresh fails (caller surfaces to
   * status).
   */
  private async ensureToken(): Promise<string> {
    if (!this.api) throw new Error('FeishuApi not initialized');
    const cached = this.cachedToken ?? readCredentials(resolveCredentialsPath(this.getConfig()));
    if (cached && this.api.isTokenValid(cached)) {
      this.cachedToken = cached;
      return cached.tenantAccessToken;
    }
    const refreshed = await this.api.fetchTenantAccessToken();
    this.cachedToken = refreshed;
    writeCredentials(resolveCredentialsPath(this.getConfig()), refreshed);
    return refreshed.tenantAccessToken;
  }

  private startTokenRefresh(): void {
    this.stopTokenRefresh();
    this.refreshTimer = setInterval(() => {
      void this.refreshTokenSafe();
    }, TOKEN_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  private stopTokenRefresh(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshTokenSafe(): Promise<void> {
    if (!this.api) return;
    try {
      const fresh = await this.api.fetchTenantAccessToken();
      // Write to disk FIRST — if it fails, keep the prior cache so the next
      // restart still has a usable token instead of an orphaned in-memory one.
      try {
        writeCredentials(resolveCredentialsPath(this.getConfig()), fresh);
      } catch (err) {
        this.status.lastError = `Token 写盘失败：${err instanceof Error ? err.message : String(err)}`;
        return;
      }
      this.cachedToken = fresh;
      this.status.lastError = null;
    } catch (err) {
      // Don't tear down the WS — the SDK keeps trying; just surface the error.
      this.status.lastError = `Token 刷新失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ----- WS connection ----------------------------------------------------

  private async startWSClient(): Promise<void> {
    if (this.wsClient) return;
    const cfg = this.getConfig();
    if (!cfg.appId || !cfg.appSecret) return;

    this.wsClient = new FeishuWSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      domain: cfg.baseUrl,
      onMessage: (event) => { void this.handleRawMessage(event); },
      onReady: () => {
        this.transitionTo('connected');
        this.status.loginStatus = 'connected';
        this.status.connected = true;
        this.status.lastError = null;
      },
      onError: (err) => {
        this.transitionTo('error');
        this.status.loginStatus = 'error';
        this.status.connected = false;
        this.status.lastError = `WS 连接失败：${err.message}`;
      },
      onReconnecting: () => {
        this.transitionTo('reconnecting');
        this.status.connected = false;
        // Keep loginStatus in sync — 'reconnecting' isn't a FeishuLoginStatus
        // state, so we surface 'connecting' (which the UI already renders as
        // a non-idle, non-error in-flight state).
        this.status.loginStatus = 'connecting';
      },
      onReconnected: () => {
        this.transitionTo('connected');
        this.status.loginStatus = 'connected';
        this.status.connected = true;
        this.status.lastError = null;
      },
    });

    try {
      await this.wsClient.start();
    } catch (err) {
      this.transitionTo('error');
      this.status.loginStatus = 'error';
      this.status.connected = false;
      this.status.lastError = `WS 启动失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async stopWSClient(): Promise<void> {
    if (!this.wsClient) return;
    await this.wsClient.stop();
    this.wsClient = null;
  }

  // ----- message handling ------------------------------------------------

  private async handleRawMessage(event: FeishuRawEvent): Promise<void> {
    const msgId = event.message?.message_id || event.event_id;
    if (msgId && this.isDuplicate(msgId)) return;

    const parsed = parseFeishuMessage(event);
    if (!parsed) return;

    this.status.lastMessageAt = Date.now();

    // /new — close conversation and cancel the reusable run (mirrors weixin).
    const trimmed = parsed.text.trim();
    if (trimmed === '/new' || trimmed === '/clear' || trimmed === '/重置') {
      const closed = this.conversations.closeExternalSession('feishu', parsed.fromUserId);
      this.dispatcher.cancelUser(parsed.fromUserId);
      if (closed) {
        await this.sendText(parsed.fromUserId, '已开启新会话。发送消息即可开始新的对话。');
      } else {
        await this.sendText(parsed.fromUserId, '当前已是新会话。');
      }
      return;
    }

    await this.createMolioRun(parsed);
  }

  private async createMolioRun(message: ParsedFeishuMessage): Promise<void> {
    const cfg = this.getConfig();
    const agentId = cfg.defaultAgentId || loadConfig().defaultAgentId;
    if (!agentId) {
      await this.sendText(message.fromUserId, 'Molio 尚未设置默认运行时，请先在桌面端运行时页面设置默认代理。');
      return;
    }

    let conversationId: string | null = null;
    try {
      const conversation = this.conversations.getOrCreateExternalConversation({
        channelType: 'feishu',
        externalSessionId: message.fromUserId,
        // Use the last 8 chars of open_id so we don't leak the full id into the UI.
        title: `飞书 ${message.fromUserId.slice(-8)}`,
        metadata: { chatId: message.chatId, chatType: message.chatType },
      });
      conversationId = conversation.id;
      const history = this.conversations.listHistory(conversation.id);
      const cwd = this.resolveRunCwd(cfg);

      // Download image/file attachments to cwd/raw/feishu/<date>/ and rewrite
      // message.text to point at the local files before running.
      await materializeFeishuAttachments(
        message,
        cwd,
        this.api ? (att: FeishuAttachment) => this.downloadAttachment(att) : undefined,
      );

      await this.dispatcher.dispatch({
        userId: message.fromUserId,
        conversationId: conversation.id,
        agentId,
        cwd,
        rawUserText: message.text,
        history,
      });
    } catch (err) {
      const text = `Molio 处理失败：${err instanceof Error ? err.message : String(err)}`;
      if (conversationId) {
        this.conversations.appendAssistantMessage(conversationId, text, { agentId });
      }
      await this.sendText(message.fromUserId, text);
    }
  }

  /** Download a Feishu attachment (image or file) via the authenticated API. */
  private async downloadAttachment(att: FeishuAttachment): Promise<{ data: Buffer; contentType: string }> {
    if (!this.api) throw new Error('FeishuApi not initialized');
    const token = await this.ensureToken();
    if (att.kind === 'image') {
      return this.api.downloadImage(token, att.key);
    }
    return this.api.downloadFile(token, att.key);
  }

  // ----- ChannelSink implementation --------------------------------------

  async sendText(toUserId: string, text: string): Promise<void> {
    if (!this.api) return;
    try {
      const token = await this.ensureToken();
      for (const chunk of this.splitText(text)) {
        await this.api.sendText(token, toUserId, chunk);
      }
    } catch (err) {
      this.status.lastError = `发送文本失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async sendMediaFile(toUserId: string, item: OutboundMediaItem): Promise<void> {
    if (!this.api) return;
    try {
      const token = await this.ensureToken();
      // Feishu's image upload endpoint only accepts raster image types
      // (png/jpg/gif/webp/bmp). Videos and other binary kinds go through the
      // file endpoint — Feishu has no separate video upload for IM messages
      // (video messages require a different message_type + upload flow).
      if (item.kind === 'image') {
        const imageKey = await this.api.uploadImage(token, item.filePath);
        await this.api.sendImage(token, toUserId, imageKey);
      } else {
        const fileKey = await this.api.uploadFile(token, item.filePath);
        await this.api.sendFile(token, toUserId, fileKey);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        `[feishu-send-media] failed: ${err instanceof Error ? err.message : String(err)} file=${item.filePath}`,
      );
    }
  }

  onActiveRun(runId: string | null): void {
    this.status.activeRunId = runId;
  }

  // ----- helpers ---------------------------------------------------------

  private splitText(text: string): string[] {
    if (text.length <= TEXT_CHUNK_LIMIT) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest) {
      if (rest.length <= TEXT_CHUNK_LIMIT) {
        chunks.push(rest);
        break;
      }
      let cut = rest.lastIndexOf('\n\n', TEXT_CHUNK_LIMIT);
      if (cut <= 0) cut = rest.lastIndexOf('\n', TEXT_CHUNK_LIMIT);
      if (cut <= 0) cut = TEXT_CHUNK_LIMIT;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, '');
    }
    return chunks;
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of this.receivedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) this.receivedMessageIds.delete(id);
    }
    if (this.receivedMessageIds.has(messageId)) return true;
    // Hard cap: if the map has grown unbounded (long-lived quiet process),
    // evict oldest entries by insertion order before inserting a new one.
    if (this.receivedMessageIds.size >= DEDUP_MAX_ENTRIES) {
      const firstKey = this.receivedMessageIds.keys().next().value;
      if (firstKey !== undefined) this.receivedMessageIds.delete(firstKey);
    }
    this.receivedMessageIds.set(messageId, now);
    return false;
  }

  private getConfig(): FeishuConfig {
    return loadConfig().feishu ?? {};
  }

  private resolveRunCwd(cfg: FeishuConfig): string | undefined {
    return loadConfig().defaultCwd || cfg.defaultCwd;
  }

  private transitionTo(state: ConnectionState): void {
    this.connectionState = state;
    this.status.connectionState = state;
  }
}

// Re-export the shared dispatcher under the feishu-friendly alias so callers
// from outside the channel module keep a stable import path.
export { ChannelDispatcher as FeishuRunDispatcher };
