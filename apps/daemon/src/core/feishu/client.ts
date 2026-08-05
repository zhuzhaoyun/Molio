import fs from 'node:fs';
import path from 'node:path';
import type { FeishuCard } from './card.js';
import type { FeishuCredentials } from './types.js';

/**
 * Default Feishu open platform base URL. Override for Lark international
 * (`https://open.larksuite.com`) or self-hosted gateway.
 */
export const DEFAULT_BASE_URL = 'https://open.feishu.cn';

/** Buffer of time before the token actually expires (ms) at which we refresh. */
const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000;
/** Hard cap on a single download's body size — prevents OOM on low-RAM
 * dev machines when the daemon proxies a 100MB Feishu attachment. */
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
/** Hard cap on an upload's source file size. `resolveDeliverable` deliberately
 * honors absolute paths in the AI's `<attach/>` marker, so the AI could point
 * at an arbitrarily large file; `readFile` would buffer it fully and OOM the
 * daemon before Feishu's own ~100MB file limit ever rejects it. Refuse up
 * front with a clear error instead. Matches Feishu's max file size so no
 * legitimate upload is lost. */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Feishu API ${res.status}: ${text || res.statusText}`);
  }
  return await res.json() as Record<string, unknown>;
}

/** Extract the typed error message from a Feishu API error response. */
function feishuErrMessage(body: Record<string, unknown>, fallback: string): string {
  const msg = body.msg;
  return typeof msg === 'string' && msg ? msg : fallback;
}

export interface FeishuTokenResponse {
  tenantAccessToken: string;
  expiresAt: number;
}

/**
 * Raw fetch-based Feishu REST client. We intentionally don't use the SDK's
 * `Client` for REST — keeping the same plain-fetch style as `weixin/client.ts`
 * keeps the channel modules symmetrical and avoids hidden axios behavior
 * (the SDK's REST client auto-retries + auto-injects token, which masks
 * errors that we want to handle at the dispatcher level).
 *
 * The SDK's `WSClient` (see `ws-client.ts`) is the only piece we use —
 * implementing the WebSocket long-connection protocol from scratch would
 * needlessly duplicate SDK work.
 */
export class FeishuApi {
  constructor(
    readonly baseUrl = DEFAULT_BASE_URL,
    readonly appId = '',
    readonly appSecret = '',
  ) {}

  /** Fetch a fresh tenant_access_token (2h validity per Feishu spec). */
  async fetchTenantAccessToken(): Promise<FeishuTokenResponse> {
    const url = `${ensureTrailingSlash(this.baseUrl)}open-apis/auth/v3/tenant_access_token/internal`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = await readJson(res);
    const code = Number(body.code ?? 0);
    if (code !== 0) {
      throw new Error(`Feishu token fetch failed: ${feishuErrMessage(body, String(code))}`);
    }
    const token = body.tenant_access_token;
    const expire = Number(body.expire ?? 7200);
    if (typeof token !== 'string' || !token) {
      throw new Error('Feishu token response missing tenant_access_token');
    }
    return {
      tenantAccessToken: token,
      // Subtract a safety window so we never serve a token that's about to expire.
      expiresAt: Date.now() + expire * 1000 - TOKEN_REFRESH_SAFETY_MS,
    };
  }

  /** Whether a cached token is still usable (false = needs refresh). */
  isTokenValid(creds: FeishuCredentials | null): boolean {
    if (!creds?.tenantAccessToken) return false;
    return creds.expiresAt > Date.now();
  }

  /**
   * Send a text message to a user (by open_id). Returns Feishu's message_id
   * on success; throws on API error.
   */
  async sendText(tenantAccessToken: string, openId: string, text: string): Promise<string> {
    return this.postMessage(tenantAccessToken, openId, 'text', { text }, 'sendText');
  }

  /**
   * Send an interactive card (JSON 2.0) to a user. Feishu renders the card's
   * markdown element, so agent Markdown output shows up formatted instead of
   * raw symbols. Same endpoint and permissions as `sendText`; throws on API
   * error (e.g. 300300 = card request body exceeds 30KB).
   */
  async sendCard(tenantAccessToken: string, openId: string, card: FeishuCard): Promise<string> {
    return this.postMessage(tenantAccessToken, openId, 'interactive', card, 'sendCard');
  }

  /** Upload an image file (multipart) and return the `image_key`. */
  async uploadImage(tenantAccessToken: string, filePath: string, maxBytes = UPLOAD_MAX_BYTES): Promise<string> {
    const url = `${ensureTrailingSlash(this.baseUrl)}open-apis/im/v1/images`;
    const form = new FormData();
    form.append('image_type', 'message');
    const buf = await this.readFileCapped(filePath, maxBytes);
    const fileName = path.basename(filePath);
    form.append('image', new Blob([buf]), fileName);

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      body: form,
    });
    const body = await readJson(res);
    const code = Number(body.code ?? 0);
    if (code !== 0) {
      throw new Error(`Feishu uploadImage failed: ${feishuErrMessage(body, String(code))}`);
    }
    const imageKey = (body.data as { image_key?: string } | undefined)?.image_key;
    if (typeof imageKey !== 'string' || !imageKey) {
      throw new Error('Feishu uploadImage response missing image_key');
    }
    return imageKey;
  }

  /** Upload a file (multipart) and return the `file_key`. */
  async uploadFile(tenantAccessToken: string, filePath: string, maxBytes = UPLOAD_MAX_BYTES): Promise<string> {
    const url = `${ensureTrailingSlash(this.baseUrl)}open-apis/im/v1/files`;
    const form = new FormData();
    form.append('file_type', 'stream');
    form.append('file_name', path.basename(filePath));
    const buf = await this.readFileCapped(filePath, maxBytes);
    form.append('file', new Blob([buf]), path.basename(filePath));

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      body: form,
    });
    const body = await readJson(res);
    const code = Number(body.code ?? 0);
    if (code !== 0) {
      throw new Error(`Feishu uploadFile failed: ${feishuErrMessage(body, String(code))}`);
    }
    const fileKey = (body.data as { file_key?: string } | undefined)?.file_key;
    if (typeof fileKey !== 'string' || !fileKey) {
      throw new Error('Feishu uploadFile response missing file_key');
    }
    return fileKey;
  }

  /** Send an image message by `image_key` (returned from `uploadImage`). */
  async sendImage(tenantAccessToken: string, openId: string, imageKey: string): Promise<string> {
    return this.sendMedia(tenantAccessToken, openId, 'image', { image_key: imageKey });
  }

  /** Send a file message by `file_key` (returned from `uploadFile`). */
  async sendFile(tenantAccessToken: string, openId: string, fileKey: string): Promise<string> {
    return this.sendMedia(tenantAccessToken, openId, 'file', { file_key: fileKey });
  }

  private async sendMedia(
    tenantAccessToken: string,
    openId: string,
    msgType: 'image' | 'file',
    content: Record<string, string>,
  ): Promise<string> {
    return this.postMessage(tenantAccessToken, openId, msgType, content, `send${msgType}`);
  }

  /**
   * Shared POST to `im/v1/messages` — sendText / sendCard / sendMedia all hit
   * this endpoint with only `msg_type` and `content` differing. Per Feishu's
   * double-encoding contract the outer request body is JSON and the `content`
   * field is itself a JSON string, hence the nested `JSON.stringify`.
   */
  private async postMessage(
    tenantAccessToken: string,
    openId: string,
    msgType: 'text' | 'image' | 'file' | 'interactive',
    content: unknown,
    opName: string,
  ): Promise<string> {
    const url = `${ensureTrailingSlash(this.baseUrl)}open-apis/im/v1/messages?receive_id_type=open_id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantAccessToken}`,
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: msgType,
        content: JSON.stringify(content),
      }),
    });
    const body = await readJson(res);
    const code = Number(body.code ?? 0);
    if (code !== 0) {
      throw new Error(`Feishu ${opName} failed: ${feishuErrMessage(body, String(code))}`);
    }
    const msgId = (body.data as { message_id?: string } | undefined)?.message_id;
    return typeof msgId === 'string' ? msgId : '';
  }

  /**
   * Download an image by `image_key`. Returns raw bytes + content-type.
   * Feishu serves image bytes directly (no AES decryption needed, unlike weixin).
   */
  async downloadImage(tenantAccessToken: string, imageKey: string, timeoutMs = 60_000): Promise<{ data: Buffer; contentType: string }> {
    const url = `${ensureTrailingSlash(this.baseUrl)}open-apis/im/v1/images/${encodeURIComponent(imageKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Feishu image download ${res.status}: ${await this.formatErrorBody(res)}`);
      }
      return await this.readCappedBody(res);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Download a file by `file_key`. Same shape as `downloadImage`.
   * Note: file downloads require the `im:resource` permission scope.
   */
  async downloadFile(tenantAccessToken: string, fileKey: string, timeoutMs = 60_000): Promise<{ data: Buffer; contentType: string }> {
    const url = `${ensureTrailingSlash(this.baseUrl)}open-apis/im/v1/files/${encodeURIComponent(fileKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Feishu file download ${res.status}: ${await this.formatErrorBody(res)}`);
      }
      return await this.readCappedBody(res);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read an upload's source file into a Buffer, refusing files larger than
   * `maxBytes` (default `UPLOAD_MAX_BYTES`). Symmetric with `readCappedBody`
   * on the download side — guards against the AI's `<attach/>` marker pointing
   * at a multi-GB file that would otherwise be buffered fully and OOM the
   * daemon before Feishu's own limit rejects it.
   */
  private async readFileCapped(filePath: string, maxBytes = UPLOAD_MAX_BYTES): Promise<Buffer> {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > maxBytes) {
      throw new Error(`Feishu upload file too large: ${stat.size} bytes > ${maxBytes}`);
    }
    return fs.promises.readFile(filePath);
  }

  /**
   * Read the response body into a Buffer, refusing to buffer more than
   * DOWNLOAD_MAX_BYTES (default 64MB). Feishu allows 100MB file uploads —
   * buffering that into a single Node Buffer can OOM a low-RAM dev machine
   * running the daemon locally, so we cap and refuse with a clear error.
   */
  private async readCappedBody(res: Response, maxBytes = DOWNLOAD_MAX_BYTES): Promise<{ data: Buffer; contentType: string }> {
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength && contentLength > maxBytes) {
      throw new Error(`Feishu download too large: content-length=${contentLength} > ${maxBytes}`);
    }
    // Stream-read with a manual byte cap so a lying/missing Content-Length
    // (or a malicious server streaming forever) still can't OOM us.
    const reader = res.body?.getReader();
    if (!reader) {
      // No streamable body — fall back to arrayBuffer(), but only after we
      // already checked Content-Length above. If a server lies or omits the
      // header, this read can still OOM; we accept the risk for the rare
      // non-streaming response (Feishu always streams) and refuse post-hoc
      // if the result exceeds the cap.
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`Feishu download too large: ${buf.length} > ${maxBytes}`);
      return { data: buf, contentType: res.headers.get('content-type') ?? '' };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Feishu download too large: streamed > ${maxBytes}`);
      }
      chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' };
  }

  /** Parse a Feishu error response body (JSON with `msg` field) for logging. */
  private async formatErrorBody(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    if (!text) return res.statusText;
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const msg = typeof body.msg === 'string' && body.msg ? body.msg : text;
      return msg;
    } catch {
      return text;
    }
  }
}
