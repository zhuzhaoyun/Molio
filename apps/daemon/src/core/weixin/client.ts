import crypto from 'node:crypto';
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CLIENT_VERSION = '131072';
const CHANNEL_VERSION = '2.0.0';
const BOT_TYPE = '3';

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function randomWechatUin(): string {
  const val = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(val), 'utf8').toString('base64');
}

/**
 * Derive a 16-byte AES key from the WeChat media key, matching the official
 * iLink bot plugin protocol (see CowAgent `download_media_from_cdn`):
 *   1. 32-char hex string → 16 raw bytes
 *   2. base64 string → decode → if 32 bytes, treat as hex-encoded → 16 bytes
 *   3. base64 string → decode → 16 raw bytes directly
 * Returns null if the key cannot be interpreted.
 */
export function deriveAesKey(aesKey: string): Buffer | null {
  // 1) hex string
  if (/^[0-9a-fA-F]{32}$/.test(aesKey)) {
    return Buffer.from(aesKey, 'hex');
  }
  // 2/3) base64
  let decoded: Buffer;
  try {
    decoded = Buffer.from(aesKey, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 32) {
    // base64 of a 32-char hex string (e.g. media.aes_key)
    const asAscii = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(asAscii)) {
      return Buffer.from(asAscii, 'hex');
    }
    return null;
  }
  if (decoded.length === 16) {
    return decoded;
  }
  return null;
}

function buildHeaders(token = ''): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': DEFAULT_CLIENT_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Weixin API ${res.status}: ${text || res.statusText}`);
  }
  return await res.json() as Record<string, unknown>;
}

export interface FetchQrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface PollQrStatusResponse {
  status?: 'wait' | 'scaned' | 'expired' | 'confirmed' | string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

export class WeixinApi {
  constructor(
    readonly baseUrl = DEFAULT_BASE_URL,
    readonly token = '',
  ) {}

  async post(endpoint: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const baseInfo = (body.base_info && typeof body.base_info === 'object')
        ? body.base_info as Record<string, unknown>
        : {};
      body.base_info = {
        ...baseInfo,
        channel_version: baseInfo.channel_version ?? CHANNEL_VERSION,
      };

      const res = await fetch(`${ensureTrailingSlash(this.baseUrl)}${endpoint}`, {
        method: 'POST',
        headers: buildHeaders(this.token),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await readJson(res);
    } finally {
      clearTimeout(timer);
    }
  }

  async getUpdates(cursor: string): Promise<Record<string, unknown>> {
    return this.post('ilink/bot/getupdates', { get_updates_buf: cursor }, 40_000);
  }

  async sendText(toUserId: string, text: string, contextToken: string): Promise<Record<string, unknown>> {
    return this.post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: randomUUID().replace(/-/g, '').slice(0, 16),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const url = `${ensureTrailingSlash(this.baseUrl)}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
        const res = await fetch(url, { signal: controller.signal });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async fetchQrCode(): Promise<FetchQrCodeResponse> {
    const url = `${ensureTrailingSlash(this.baseUrl)}ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
    const res = await fetch(url);
    return await readJson(res) as FetchQrCodeResponse;
  }

  async pollQrStatus(qrcode: string): Promise<PollQrStatusResponse> {
    const url = `${ensureTrailingSlash(this.baseUrl)}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const res = await fetch(url, {
      headers: {
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': DEFAULT_CLIENT_VERSION,
      },
    });
    return await readJson(res) as PollQrStatusResponse;
  }

  /**
   * Download a media attachment (file/image) from its signed CDN URL and
   * AES-128-ECB decrypt it. The iLink bot API returns `media.full_url` that
   * is directly fetchable with no extra auth, but the response is encrypted
   * with the per-message `aeskey` (AES-128-ECB, PKCS7 padding). Returns the
   * decrypted bytes + the best-guess content-type.
   */
  async downloadMedia(url: string, aesKey?: string, timeoutMs = 60_000): Promise<{ data: Buffer; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let cipherBytes: Buffer;
    let contentType: string;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Weixin media download ${res.status}: ${text || res.statusText}`);
      }
      cipherBytes = Buffer.from(await res.arrayBuffer());
      contentType = res.headers.get('content-type') ?? '';
    } finally {
      clearTimeout(timer);
    }

    if (!aesKey) {
      // No key → assume the response is already plaintext (forward-compat).
      return { data: cipherBytes, contentType };
    }

    const key = deriveAesKey(aesKey);
    if (!key) {
      throw new Error(`Weixin media: cannot derive AES key from "${aesKey.slice(0, 16)}…"`);
    }
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
    // Strip PKCS7 padding if it looks valid.
    const pad = decrypted[decrypted.length - 1] ?? 0;
    if (pad > 0 && pad <= 16) {
      let valid = true;
      for (let i = 0; i < pad; i += 1) {
        if (decrypted[decrypted.length - 1 - i] !== pad) { valid = false; break; }
      }
      if (valid) return { data: decrypted.subarray(0, decrypted.length - pad), contentType };
    }
    return { data: decrypted, contentType };
  }
}

export { DEFAULT_BASE_URL };
