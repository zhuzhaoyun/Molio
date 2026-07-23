import fs from 'node:fs';
import QRCode from 'qrcode';
import type Database from 'better-sqlite3';
import type { RunManager } from '../RunManager.js';
import type { ConversationService } from '../conversations/service.js';
import { loadConfig, saveConfig, type WeixinConfig } from '../config.js';
import { ChannelDispatcher } from '../channels/dispatcher.js';
import type { ChannelSink } from '../channels/types.js';
import {
  readCredentials as readCredFile,
  removeCredentials,
  resolveCredentialsPath as resolveCredsPath,
  writeCredentials,
} from '../channels/credentials-store.js';
import { MessageDedup } from '../channels/message-dedup.js';
import { chunkText } from '../channels/text-chunker.js';
import { DEFAULT_BASE_URL, WeixinApi } from './client.js';
import { buildMolioPrompt } from './message.js';
import { wikiPromptFileFor } from './dispatcher.js';
import { parseWeixinMessage } from './message.js';
import { materializeAttachments } from './media.js';
import type {
  ConnectionState,
  ParsedWeixinMessage,
  WeixinCredentials,
  WeixinStatus,
} from './types.js';
import type { OutboundMediaItem } from '../channels/types.js';
import { UploadMediaType } from './types.js';

const SESSION_EXPIRED_CODE = -14;
const QR_LOGIN_TIMEOUT_MS = 8 * 60 * 1000;
const QR_MAX_REFRESHES = 10;
const TEXT_CHUNK_LIMIT = 4000;
/** Dedup window for received message_id (matches feishu). */
const DEDUP_TTL_MS = 7 * 60 * 60 * 1000;
/** Health probe interval when in unhealthy state (ms). */
const HEALTH_PROBE_INTERVAL_MS = 30_000;

const WEIXIN_CHANNEL_PREFIX = 'weixin';

function resolveCredentialsPath(config?: WeixinConfig): string {
  return resolveCredsPath(config?.credentialsPath, WEIXIN_CHANNEL_PREFIX);
}

function readCredentials(file: string): WeixinCredentials | null {
  return readCredFile<WeixinCredentials>(file, (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<WeixinCredentials>;
    if (typeof r.token !== 'string' || !r.token) return null;
    if (typeof r.baseUrl !== 'string' || !r.baseUrl) return null;
    return { token: r.token, baseUrl: r.baseUrl, botId: r.botId, userId: r.userId, contextTokens: r.contextTokens };
  });
}

async function toQrDataUrl(content: string): Promise<string> {
  if (!content) return '';
  if (content.startsWith('data:image/')) return content;
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 192,
  });
}

export class WeixinService implements ChannelSink {
  private api: WeixinApi | null = null;
  private cursor = '';
  private connectionState: ConnectionState = 'idle';
  private loginAbort: AbortController | null = null;
  private pollAbort: AbortController | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private contextTokens = new Map<string, string>();
  private readonly dedup = new MessageDedup({ ttlMs: DEDUP_TTL_MS });
  /** Multi-turn run reuse state machine (per-user run/queue/drain). */
  private readonly dispatcher: ChannelDispatcher;
  private status: WeixinStatus = {
    enabled: false,
    loginStatus: 'idle',
    connected: false,
    qrcodeUrl: '',
    lastError: null,
    lastMessageAt: null,
    activeRunId: null,
    hasCredentials: false,
    connectionState: 'idle',
  };

  constructor(
    private readonly runManager: RunManager,
    private readonly conversations: ConversationService,
    private readonly db?: Database.Database,
  ) {
    // The shared dispatcher owns run/queue state; the channel owns the send
    // path (it depends on `api` + `contextTokens`, which live here). `this` is
    // the sink, so dispatches always use the current api/context token.
    this.dispatcher = new ChannelDispatcher({
      runManager,
      conversations,
      db,
      sink: this,
      wikiPromptFileFor,
      buildPrompt: buildMolioPrompt,
      channelLabel: 'weixin',
    });
  }

  getStatus(): WeixinStatus {
    const cfg = this.getConfig();
    const credentialsPath = resolveCredentialsPath(cfg);
    return {
      ...this.status,
      enabled: !!cfg.enabled,
      hasCredentials: fs.existsSync(credentialsPath),
      connectionState: this.connectionState,
    };
  }

  async updateConfig(next: WeixinConfig): Promise<WeixinStatus> {
    const config = loadConfig();
    config.weixin = {
      ...(config.weixin ?? {}),
      ...next,
    };
    saveConfig(config);

    if (config.weixin.enabled) {
      await this.start();
    } else {
      this.stop();
    }

    return this.getStatus();
  }

  async start(): Promise<WeixinStatus> {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.status.enabled = false;
      return this.getStatus();
    }

    // Already actively polling — nothing to do.
    if (this.connectionState === 'polling' && this.api) return this.getStatus();
    // Already probing for recovery — let it continue.
    if (this.connectionState === 'unhealthy') return this.getStatus();
    // Login flow in progress — don't interfere.
    if (this.connectionState === 'connecting') return this.getStatus();

    const credentialsPath = resolveCredentialsPath(cfg);
    const credentials = readCredentials(credentialsPath);
    if (credentials) {
      this.transitionTo('connecting');
      this.contextTokens = new Map(Object.entries(credentials.contextTokens ?? {}));
      this.api = new WeixinApi(credentials.baseUrl, credentials.token);
      this.status.loginStatus = 'logged_in';
      this.status.connected = true;
      this.status.qrcodeUrl = '';
      this.status.lastError = null;
      this.startPolling();
    } else {
      this.transitionTo('idle');
      this.status.loginStatus = 'idle';
      this.status.connected = false;
      this.status.lastError = null;
    }

    return this.getStatus();
  }

  stop(): WeixinStatus {
    this.stopHealthProbe();
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.loginAbort?.abort();
    this.loginAbort = null;
    // Tear down any reusable multi-turn runs so we don't orphan claude
    // processes when the channel stops.
    this.dispatcher.cancelAll();
    this.api = null;
    this.cursor = '';
    this.transitionTo('idle');
    this.status = {
      ...this.status,
      enabled: false,
      loginStatus: 'idle',
      connected: false,
      qrcodeUrl: '',
    };
    return this.getStatus();
  }

  disconnect(): WeixinStatus {
    this.stop();
    removeCredentials(resolveCredentialsPath(this.getConfig()));
    const config = loadConfig();
    config.weixin = {
      ...(config.weixin ?? {}),
      enabled: false,
    };
    saveConfig(config);
    return this.getStatus();
  }

  async beginLogin(): Promise<WeixinStatus> {
    const cfg = this.getConfig();
    const config = loadConfig();
    config.weixin = {
      ...(config.weixin ?? {}),
      enabled: true,
    };
    saveConfig(config);

    // Clean up any existing polling/health probe before starting login.
    this.stopHealthProbe();
    this.pollAbort?.abort();
    this.pollAbort = null;

    this.loginAbort?.abort();
    this.loginAbort = new AbortController();
    const abortSignal = this.loginAbort.signal;
    const api = new WeixinApi(cfg.baseUrl || DEFAULT_BASE_URL);

    this.transitionTo('connecting');
    this.status = {
      ...this.status,
      enabled: true,
      loginStatus: 'waiting_scan',
      connected: false,
      qrcodeUrl: '',
      lastError: null,
    };

    void this.loginLoop(api, abortSignal);
    return this.getStatus();
  }

  private async loginLoop(api: WeixinApi, abortSignal: AbortSignal): Promise<void> {
    try {
      let refreshes = 0;
      const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
      let qr = await api.fetchQrCode();

      while (!abortSignal.aborted && Date.now() < deadline) {
        let qrcode = qr.qrcode ?? '';
        let qrcodeContent = qr.qrcode_img_content ?? '';
        if (!qrcode) throw new Error('Weixin QR response did not include qrcode');

        this.status.qrcodeUrl = await toQrDataUrl(qrcodeContent || qrcode);
        this.status.loginStatus = 'waiting_scan';

        while (!abortSignal.aborted && Date.now() < deadline) {
          const status = await api.pollQrStatus(qrcode);
          if (status.status === 'scaned') {
            this.status.loginStatus = 'scanned';
          } else if (status.status === 'expired') {
            refreshes += 1;
            if (refreshes >= QR_MAX_REFRESHES) throw new Error('Weixin QR code expired too many times');
            qr = await api.fetchQrCode();
            qrcode = qr.qrcode ?? '';
            qrcodeContent = qr.qrcode_img_content ?? '';
            this.status.qrcodeUrl = await toQrDataUrl(qrcodeContent || qrcode);
            this.status.loginStatus = 'waiting_scan';
            continue;
          } else if (status.status === 'confirmed') {
            const token = status.bot_token ?? '';
            if (!token) throw new Error('Weixin login confirmed without bot_token');
            const credentials: WeixinCredentials = {
              token,
              baseUrl: status.baseurl ?? api.baseUrl,
              botId: status.ilink_bot_id,
              userId: status.ilink_user_id,
              contextTokens: {},
            };
            writeCredentials(resolveCredentialsPath(this.getConfig()), credentials);
            this.api = new WeixinApi(credentials.baseUrl, credentials.token);
            this.contextTokens.clear();
            this.status = {
              ...this.status,
              loginStatus: 'logged_in',
              connected: true,
              qrcodeUrl: '',
              lastError: null,
            };
            this.startPolling();
            return;
          }

          await this.sleep(1_000, abortSignal);
        }
      }

      if (!abortSignal.aborted) throw new Error('Weixin QR login timed out');
    } catch (err) {
      if (abortSignal.aborted) return;
      this.status.loginStatus = 'error';
      this.status.connected = false;
      this.status.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Transition to a new connection state and sync the status object. */
  private transitionTo(state: ConnectionState): void {
    this.connectionState = state;
    this.status.connectionState = state;
  }

  /** Start the poll loop and health probe timer. Assumes this.api is set. */
  private startPolling(): void {
    this.transitionTo('polling');
    this.pollAbort?.abort();
    this.pollAbort = new AbortController();
    void this.pollLoop(this.pollAbort.signal);
    this.startHealthProbe();
  }

  /** Stop the periodic health probe timer. */
  private stopHealthProbe(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** Start a periodic health probe that detects network recovery while unhealthy. */
  private startHealthProbe(): void {
    this.stopHealthProbe();
    this.healthTimer = setInterval(() => {
      void this.runHealthProbe();
    }, HEALTH_PROBE_INTERVAL_MS);
    // Don't keep the process alive just for the health probe.
    if (this.healthTimer && typeof this.healthTimer === 'object' && 'unref' in this.healthTimer) {
      (this.healthTimer as NodeJS.Timeout).unref();
    }
  }

  /** Execute a single health probe tick. */
  private async runHealthProbe(): Promise<void> {
    if (!this.api) return;

    // While polling normally, use the probe to detect silent hangs.
    // While unhealthy, use it to detect network recovery.
    const healthy = await this.api.healthCheck();

    if (healthy && this.connectionState === 'unhealthy') {
      // Network recovered — restart polling with existing credentials.
      this.status.lastError = null;
      this.startPolling();
      return;
    }

    if (!healthy && this.connectionState === 'polling') {
      // Probe failed while we thought we were fine — the getUpdates fetch
      // may be silently hung. Abort it and transition to unhealthy.
      this.pollAbort?.abort();
      this.pollAbort = null;
      this.transitionTo('unhealthy');
      this.status.connected = false;
      this.status.lastError = 'Network unreachable (detected by health probe). Waiting for recovery...';
    }
  }

  private async pollLoop(abortSignal: AbortSignal): Promise<void> {
    while (!abortSignal.aborted && this.api) {
      try {
        const response = await this.api.getUpdates(this.cursor);

        // If we were aborted while waiting for getUpdates, exit cleanly.
        if (abortSignal.aborted) break;

        const ret = Number(response.ret ?? 0);
        const errcode = Number(response.errcode ?? 0);
        if (ret === SESSION_EXPIRED_CODE || errcode === SESSION_EXPIRED_CODE) {
          this.transitionTo('expired');
          this.status.loginStatus = 'error';
          this.status.connected = false;
          this.status.lastError = 'Weixin session expired. Please reconnect.';
          removeCredentials(resolveCredentialsPath(this.getConfig()));
          this.api = null;
          this.stopHealthProbe();
          return;
        }
        if (ret !== 0 || errcode !== 0) {
          throw new Error(String(response.errmsg ?? `getupdates failed: ${ret || errcode}`));
        }

        this.status.connected = true;
        this.status.loginStatus = 'logged_in';
        this.status.lastError = null;

        const nextCursor = response.get_updates_buf;
        if (typeof nextCursor === 'string' && nextCursor) this.cursor = nextCursor;

        const msgs = Array.isArray(response.msgs) ? response.msgs : [];
        for (const raw of msgs) {
          if (raw && typeof raw === 'object') {
            await this.handleRawMessage(raw as Parameters<typeof parseWeixinMessage>[0]);
          }
        }
      } catch (err) {
        if (abortSignal.aborted) break;
        // Network/API error — transition to unhealthy and let the health
        // probe handle recovery detection instead of blind retries.
        this.status.lastError = err instanceof Error ? err.message : String(err);
        this.status.connected = false;
        this.transitionTo('unhealthy');
        return;
      }
    }

    // Loop exited without explicit state change (e.g. abort) — if we still
    // think we're polling, something unexpected happened. Mark unhealthy so
    // the health probe can attempt recovery.
    if (this.connectionState === 'polling' && !abortSignal.aborted) {
      this.transitionTo('unhealthy');
      this.status.connected = false;
    }
  }

  private async handleRawMessage(raw: Parameters<typeof parseWeixinMessage>[0]): Promise<void> {
    const msgId = String(raw.message_id ?? raw.seq ?? '');
    if (msgId && this.dedup.check(msgId)) return;

    const parsed = parseWeixinMessage(raw);
    if (!parsed) return;

    this.status.lastMessageAt = Date.now();
    if (parsed.contextToken) {
      this.contextTokens.set(parsed.fromUserId, parsed.contextToken);
      this.persistContextTokens();
    }

    // Handle /new command — close current conversation, next message starts fresh
    const trimmed = parsed.text.trim();
    if (trimmed === '/new' || trimmed === '/clear' || trimmed === '/重置') {
      const closed = this.conversations.closeExternalSession('weixin', parsed.fromUserId);
      // Drop the reusable run too so the next message spawns a fresh session
      // (new conversation, no prior context).
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

  private async createMolioRun(message: ParsedWeixinMessage): Promise<void> {
    const cfg = this.getConfig();
    const agentId = cfg.defaultAgentId || loadConfig().defaultAgentId;
    if (!agentId) {
      await this.sendText(message.fromUserId, 'Molio 尚未设置默认运行时，请先在桌面端运行时页面设置默认代理。');
      return;
    }

    let conversationId: string | null = null;
    try {
      const conversation = this.conversations.getOrCreateExternalConversation({
        channelType: 'weixin',
        externalSessionId: message.fromUserId,
        title: `微信 ${message.fromUserId}`,
        metadata: {
          toUserId: message.toUserId,
        },
      });
      conversationId = conversation.id;
      const history = this.conversations.listHistory(conversation.id);

      const cwd = this.resolveRunCwd(cfg);
      // Download any file/image attachments to cwd/raw/wechat/<date>/ and
      // rewrite message.text to point at the local files before running.
      await materializeAttachments(
        message,
        cwd,
        this.api ? (url, aesKey) => this.api!.downloadMedia(url, aesKey) : undefined,
      );

      // Hand off to the dispatcher: it decides reuse-vs-fresh-spawn, derives
      // the wiki system-prompt file at spawn time, and serializes turns.
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

  async sendText(toUserId: string, text: string): Promise<void> {
    if (!this.api) return;
    const contextToken = this.contextTokens.get(toUserId);
    if (!contextToken) return;

    for (const chunk of chunkText(text, TEXT_CHUNK_LIMIT)) {
      const response = await this.api.sendText(toUserId, chunk, contextToken);
      const ret = Number(response.ret ?? 0);
      const errcode = Number(response.errcode ?? 0);
      if (ret === SESSION_EXPIRED_CODE || errcode === SESSION_EXPIRED_CODE) {
        this.contextTokens.delete(toUserId);
        this.persistContextTokens();
        return;
      }
    }
  }

  /**
   * Upload a local file to the Weixin CDN and deliver it as an image/file/
   * video message. Best-effort: failures are logged but never break the text
   * reply. Drops the context token on session expiry, mirroring sendText.
   */
  async sendMediaFile(toUserId: string, item: OutboundMediaItem): Promise<void> {
    if (!this.api) return;
    const contextToken = this.contextTokens.get(toUserId);
    if (!contextToken) return;

    const mediaType = item.kind === 'image'
      ? UploadMediaType.IMAGE
      : item.kind === 'video'
        ? UploadMediaType.VIDEO
        : UploadMediaType.FILE;

    try {
      const uploaded = await this.api.uploadMedia(item.filePath, toUserId, mediaType);
      const response = item.kind === 'image'
        ? await this.api.sendImageMessage(toUserId, uploaded, contextToken)
        : item.kind === 'video'
          ? await this.api.sendVideoMessage(toUserId, uploaded, contextToken)
          : await this.api.sendFileMessage(toUserId, item.fileName, uploaded, contextToken);
      const ret = Number(response.ret ?? 0);
      const errcode = Number(response.errcode ?? 0);
      if (ret === SESSION_EXPIRED_CODE || errcode === SESSION_EXPIRED_CODE) {
        this.contextTokens.delete(toUserId);
        this.persistContextTokens();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        `[weixin-send-media] failed: ${err instanceof Error ? err.message : String(err)} file=${item.filePath}`,
      );
    }
  }

  /** ChannelSink: track the currently-active run for status display. */
  onActiveRun(runId: string | null): void {
    this.status.activeRunId = runId;
  }

  private persistContextTokens(): void {
    const credentialsPath = resolveCredentialsPath(this.getConfig());
    const credentials = readCredentials(credentialsPath);
    if (!credentials) return;
    credentials.contextTokens = Object.fromEntries(this.contextTokens);
    writeCredentials(credentialsPath, credentials);
  }

  private getConfig(): WeixinConfig {
    return loadConfig().weixin ?? {};
  }

  private resolveRunCwd(cfg: WeixinConfig): string | undefined {
    return loadConfig().defaultCwd || cfg.defaultCwd;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
