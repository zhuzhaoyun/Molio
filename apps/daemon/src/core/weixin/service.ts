import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import type Database from 'better-sqlite3';
import type { AgentEvent } from '@molio/contracts';
import type { RunManager } from '../RunManager.js';
import type { ConversationService } from '../conversations/service.js';
import { loadConfig, saveConfig, type WeixinConfig } from '../config.js';
import { getVaultByPath } from '../db.js';
import { WIKI_WEIXIN_PROMPT } from '../wiki-prompts.js';
import { DEFAULT_BASE_URL, WeixinApi } from './client.js';
import { buildMolioPrompt, parseWeixinMessage } from './message.js';
import { materializeAttachments } from './media.js';
import type { ConnectionState, ParsedWeixinMessage, WeixinCredentials, WeixinStatus } from './types.js';

const SESSION_EXPIRED_CODE = -14;
const QR_LOGIN_TIMEOUT_MS = 8 * 60 * 1000;
const QR_MAX_REFRESHES = 10;
const TEXT_CHUNK_LIMIT = 4000;
const RUN_REPLY_TIMEOUT_MS = 5 * 60 * 1000;
/** Health probe interval when in unhealthy state (ms). */
const HEALTH_PROBE_INTERVAL_MS = 30_000;

function configDir(): string {
  return path.join(os.homedir(), '.molio');
}

function defaultCredentialsPath(): string {
  return path.join(configDir(), 'weixin-credentials.json');
}

function resolveCredentialsPath(config?: WeixinConfig): string {
  const configured = config?.credentialsPath;
  if (!configured) return defaultCredentialsPath();
  if (configured.startsWith('~')) return path.join(os.homedir(), configured.slice(1));
  return configured;
}

function readCredentials(file: string): WeixinCredentials | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WeixinCredentials;
    if (!parsed.token || !parsed.baseUrl) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCredentials(file: string, credentials: WeixinCredentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows and some filesystems ignore POSIX modes.
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

async function toQrDataUrl(content: string): Promise<string> {
  if (!content) return '';
  if (content.startsWith('data:image/')) return content;
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 192,
  });
}

export function buildWeixinRunMessage(
  db: Database.Database | undefined,
  text: string,
  cwd: string | undefined,
  _isFirstTurn: boolean,
): string {
  const message = buildMolioPrompt(text);
  if (!db || !cwd) return message;

  const vault = getVaultByPath(db, cwd);
  if (!vault) return message;

  return `${WIKI_WEIXIN_PROMPT}\n\n---\n\n用户消息：${message}`;
}

export class WeixinService {
  private api: WeixinApi | null = null;
  private cursor = '';
  private connectionState: ConnectionState = 'idle';
  private loginAbort: AbortController | null = null;
  private pollAbort: AbortController | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private contextTokens = new Map<string, string>();
  private receivedMessageIds = new Map<string, number>();
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
  ) {}

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
    if (msgId && this.isDuplicate(msgId)) return;

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

      this.conversations.appendUserMessage(conversation.id, message.text);
      const runId = await this.runManager.createRun({
        agentId,
        cwd,
        message: buildWeixinRunMessage(this.db, message.text, cwd, history.length === 0),
        conversationId: conversation.id,
        history,
      });
      this.status.activeRunId = runId;
      await this.sendText(message.fromUserId, 'Molio 正在处理...');
      void this.forwardRunReply(runId, message.fromUserId, conversation.id, agentId);
    } catch (err) {
      const text = `Molio 处理失败：${err instanceof Error ? err.message : String(err)}`;
      if (conversationId) {
        this.conversations.appendAssistantMessage(conversationId, text, { agentId });
      }
      await this.sendText(message.fromUserId, text);
    }
  }

  private async forwardRunReply(
    runId: string,
    toUserId: string,
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    let reply = '';
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const finish = async (text: string) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      clearTimeout(timer);
      this.conversations.appendAssistantMessage(conversationId, text, { agentId, runId });
      await this.sendText(toUserId, text);
    };

    const handleEvent = (event: AgentEvent) => {
      if (event.type === 'text_delta') {
        reply += event.delta;
        return;
      }

      if (event.type === 'error') {
        void finish(`Molio 处理失败：${event.message}`);
        return;
      }

      if (event.type === 'turn_end') {
        const text = reply.trim();
        void finish(text || 'Molio 已完成处理，但没有返回文本内容。');
        return;
      }

      if (event.type === 'status' && (event.label === 'failed' || event.label === 'canceled')) {
        void finish(`Molio 运行已${event.label === 'failed' ? '失败' : '取消'}。`);
        return;
      }

      if (event.type === 'status' && event.label === 'completed') {
        const text = reply.trim();
        void finish(text || 'Molio 已完成处理，但没有返回文本内容。');
      }
    };

    const timer = setTimeout(() => {
      void finish(reply.trim() || `Molio 仍在处理，稍后可在桌面端查看运行：${runId}`);
    }, RUN_REPLY_TIMEOUT_MS);
    timer.unref?.();

    unsubscribe = this.runManager.onEvent(runId, handleEvent);
    if (!unsubscribe) {
      clearTimeout(timer);
      await this.sendText(toUserId, `Molio 已创建运行，但无法订阅结果：${runId}`);
    }
  }

  private async sendText(toUserId: string, text: string): Promise<void> {
    if (!this.api) return;
    const contextToken = this.contextTokens.get(toUserId);
    if (!contextToken) return;

    for (const chunk of this.splitText(text)) {
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

  private persistContextTokens(): void {
    const credentialsPath = resolveCredentialsPath(this.getConfig());
    const credentials = readCredentials(credentialsPath);
    if (!credentials) return;
    credentials.contextTokens = Object.fromEntries(this.contextTokens);
    writeCredentials(credentialsPath, credentials);
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of this.receivedMessageIds) {
      if (now - ts > 7 * 60 * 60 * 1000) this.receivedMessageIds.delete(id);
    }
    if (this.receivedMessageIds.has(messageId)) return true;
    this.receivedMessageIds.set(messageId, now);
    return false;
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
