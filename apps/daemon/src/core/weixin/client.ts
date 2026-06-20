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
}

export { DEFAULT_BASE_URL };
