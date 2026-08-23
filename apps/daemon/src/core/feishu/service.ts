import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { RunManager } from '../RunManager.js';
import type { ConversationService } from '../conversations/service.js';
import { loadConfig, saveConfig, type FeishuConfig } from '../config.js';
import { ChannelDispatcher } from '../channels/dispatcher.js';
import type { ChannelSink } from '../channels/types.js';
import {
  removeCredentials,
  resolveCredentialsPath as resolveCredsPath,
} from '../channels/credentials-store.js';
import { MessageDedup } from '../channels/message-dedup.js';
import { chunkText } from '../channels/text-chunker.js';
import { buildMarkdownCard } from './card.js';
import { DEFAULT_BASE_URL, FeishuApi } from './client.js';
import { FeishuWSClient } from './ws-client.js';
import { FeishuTokenStore } from './token-store.js';
import {
  buildFeishuFrameMessage,
  buildFeishuPrompt,
  buildFeishuReminderMessage,
  parseFeishuMessage,
} from './message.js';
import { materializeFeishuAttachments } from './media.js';
import { materializeWikiLinks } from './wiki-fetcher.js';
import type {
  FeishuAttachment,
  FeishuRawEvent,
  FeishuStatus,
  ParsedFeishuMessage,
} from './types.js';
import type { ConnectionState } from '../channels/types.js';
import type { OutboundMediaItem } from '../channels/types.js';

/** Dedup window for received message_id (matches weixin). */
const DEDUP_TTL_MS = 7 * 60 * 60 * 1000;
/** Hard cap on the dedup map so a quiet-but-long-lived process can't leak
 * memory indefinitely. 7h TTL means ~10k entries at 1 msg/s sustained. */
const DEDUP_MAX_ENTRIES = 10_000;
/** Chunk size for sendText — Feishu's text limit is 4096 bytes; use 3000
 * chars for safety. Cards allow ~30KB per request, but replies are chunked at
 * the text limit anyway: when card sending fails we fall back to plain text,
 * which must stay within the 4096-byte bound without a separate chunk size. */
const TEXT_CHUNK_LIMIT = 3000;

const FEISHU_CHANNEL_PREFIX = 'feishu';

function resolveCredentialsPath(config?: FeishuConfig): string {
  return resolveCredsPath(config?.credentialsPath, FEISHU_CHANNEL_PREFIX);
}

export class FeishuService implements ChannelSink {
  private api: FeishuApi | null = null;
  private wsClient: FeishuWSClient | null = null;
  private connectionState: ConnectionState = 'idle';
  private readonly dedup = new MessageDedup({ ttlMs: DEDUP_TTL_MS, maxEntries: DEDUP_MAX_ENTRIES });
  /** tenant_access_token cache + periodic refresh — owns disk persistence. */
  private readonly tokenStore: FeishuTokenStore;
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
    this.tokenStore = new FeishuTokenStore({
      getApi: () => this.api,
      getConfig: () => this.getConfig(),
      onPersistError: (msg) => { this.status.lastError = msg; },
    });
    this.dispatcher = new ChannelDispatcher({
      runManager,
      conversations,
      db,
      sink: this,
      buildPrompt: buildFeishuPrompt,
      // Symmetric with weixin: the full role frame rides the FIRST-TURN
      // message prepend (frameFirstTurn) — the reliable carrier. The old
      // --append-system-prompt-file path was silently dropped by the CLI in
      // some environments (the frame never reached the model). Reuse turns
      // carry only the compact attach reminder: it keeps the <attach/>
      // protocol alive across context compaction without re-triggering the
      // full frame's 收件/入库/问答 routing on every message.
      frameFirstTurn: buildFeishuFrameMessage,
      reuseTurnReminder: buildFeishuReminderMessage,
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
      this.tokenStore.invalidate();
      await this.stopWSClient();
    }

    if (config.feishu.enabled) {
      await this.start();
    } else {
      await this.stop();
    }

    return this.getStatus();
  }

  /**
   * Bring the channel up.
   *
   * @param force Explicit-user-action semantics (the HTTP `POST /start`
   *   button). When true, a disabled channel is re-enabled first (disconnect()
   *   persists `enabled:false`) and any live/in-flight WS connection is torn
   *   down so a fresh one is established — this is what powers "启动连接" after
   *   a disconnect and "重新连接" while already connected. Boot auto-start and
   *   the config-save path call `start()` WITHOUT force, so a disabled channel
   *   still stays off across restarts and a healthy connection isn't disturbed.
   */
  async start(force = false): Promise<FeishuStatus> {
    let cfg = this.getConfig();
    if (!cfg.enabled) {
      if (!force) {
        this.status.enabled = false;
        return this.getStatus();
      }
      // Explicit "启动连接" — disconnect() disabled the channel, re-enable it.
      const config = loadConfig();
      config.feishu = { ...(config.feishu ?? {}), enabled: true };
      saveConfig(config);
      cfg = this.getConfig();
    }
    if (!cfg.appId || !cfg.appSecret) {
      this.transitionTo('idle');
      this.status.loginStatus = 'idle';
      this.status.connected = false;
      this.status.lastError = '缺少 appId/appSecret，请在飞书开放平台创建自建应用后填入。';
      return this.getStatus();
    }

    if (force) {
      // "重新连接" — drop the existing WS client + token refresh so the code
      // below re-establishes a fresh connection instead of no-op'ing on the
      // already-connected guard.
      await this.stopWSClient();
      this.tokenStore.stopRefresh();
    } else {
      // Auto-start / config-save path — don't disturb a healthy connection.
      if (this.connectionState === 'connected' && this.wsClient) return this.getStatus();
      if (this.connectionState === 'connecting') return this.getStatus();
    }

    this.transitionTo('connecting');
    this.status.loginStatus = 'connecting';
    this.status.connected = false;
    this.status.lastError = null;

    this.api = new FeishuApi(cfg.baseUrl || DEFAULT_BASE_URL, cfg.appId, cfg.appSecret);

    // Try to load a cached token; if it's stale, refresh now (proves creds work).
    try {
      await this.tokenStore.getToken();
    } catch (err) {
      this.transitionTo('error');
      this.status.loginStatus = 'error';
      this.status.lastError = `Token 获取失败：${err instanceof Error ? err.message : String(err)}`;
      return this.getStatus();
    }

    // Start the WS long-connection. SDK handles reconnect/ping.
    await this.startWSClient();
    this.tokenStore.startRefresh();
    return this.getStatus();
  }

  async stop(): Promise<FeishuStatus> {
    this.tokenStore.stopRefresh();
    await this.stopWSClient();
    this.dispatcher.cancelAll();
    this.api = null;
    this.tokenStore.invalidate();
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
      // Drop the failed client so the next start() can construct a fresh one.
      // (FeishuWSClient.start clears `this.client` on throw, but the
      // `if (this.wsClient) return` guard at the top of startWSClient would
      // otherwise no-op a retry.)
      this.wsClient = null;
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
    if (msgId && this.dedup.check(msgId)) return;

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

      // Pre-fetch feishu wiki/docx 正文 Markdown via the desktop-side
      // BrowserView (env MOLIO_DESKTOP_FETCH_PORT points at the local HTTP
      // server the Electron main process exposes). When port is unset (dev
      // mode without Electron parent), this falls back to injecting a clear
      // "未启用桌面端抓取" note alongside the URL — better than letting the
      // agent try (and fail) to curl the URL through feishu's CDN edge wall.
      // Must run BEFORE buildFeishuPrompt wraps the text so the prompt builder
      // sees the injected markdown and reframes accordingly.
      if (message.text) {
        const wikiFetchPort = Number(process.env.MOLIO_DESKTOP_FETCH_PORT ?? '') || undefined;
        message.text = await materializeWikiLinks(message.text, { port: wikiFetchPort });
      }

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

  /**
   * Download a Feishu attachment (image or file) that a user sent, via the
   * message-resource endpoint `im/v1/messages/{message_id}/resources/{key}`.
   * The plain `im/v1/files|images` endpoints only serve app-uploaded
   * resources and fail user-sent keys with 234008 — see client.ts. No
   * fallback to the legacy endpoints: without `messageId` they are
   * guaranteed to 400 for user files, so an explicit error is better than
   * false hope.
   */
  private async downloadAttachment(att: FeishuAttachment): Promise<{ data: Buffer; contentType: string }> {
    if (!this.api) throw new Error('FeishuApi not initialized');
    if (!att.messageId) {
      throw new Error('attachment has no messageId — cannot download user-sent resource');
    }
    const token = await this.tokenStore.getToken();
    return this.api.downloadMessageResource(token, att.messageId, att.key, att.kind);
  }

  // ----- ChannelSink implementation --------------------------------------

  async sendText(toUserId: string, text: string): Promise<void> {
    if (!this.api) return;
    try {
      const token = await this.tokenStore.getToken();
      for (const chunk of chunkText(text, TEXT_CHUNK_LIMIT)) {
        try {
          // Interactive card: Feishu renders the markdown element, so agent
          // replies show up formatted instead of raw Markdown symbols.
          await this.api.sendCard(token, toUserId, buildMarkdownCard(chunk));
        } catch {
          // Card rejected (ancient Feishu client / transient card-service
          // hiccup) — fall back to plain text so the user never loses a reply.
          await this.api.sendText(token, toUserId, chunk);
        }
      }
    } catch (err) {
      this.status.lastError = `发送消息失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Upload + send one attachment. FAILURES RETHROW (after logging): the
   * dispatcher catches them and tells the user which file was not delivered.
   * Swallowing here used to leave the user with reply text claiming "已附上"
   * and no file, no notice (2026-08-23 incident).
   */
  async sendMediaFile(toUserId: string, item: OutboundMediaItem): Promise<void> {
    if (!this.api) throw new Error('FeishuApi not initialized — cannot send attachment');
    try {
      const token = await this.tokenStore.getToken();
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
      throw err;
    }
  }

  onActiveRun(runId: string | null): void {
    this.status.activeRunId = runId;
  }

  // ----- helpers ---------------------------------------------------------

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
