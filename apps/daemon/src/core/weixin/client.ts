import crypto from 'node:crypto';
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CDN_BASE_URL,
  MessageItemType,
  MessageType,
  MessageState,
  UploadMediaType,
  type UploadedFileInfo,
} from './types.js';

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

/** AES-128-ECB ciphertext size with PKCS7 padding (16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** Encrypt a buffer with AES-128-ECB and PKCS7 padding (matches WeChat CDN media). */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Encode an AES key (raw 16 bytes or hex string) as the base64 `aes_key` field. */
export function encodeAesKeyField(aeskeyHex: string): string {
  // iLink stores aes_key as base64 of the hex-string UTF-8 bytes (see inbound
  // media.aes_key), so the outbound form must match for round-trip decryption.
  return Buffer.from(aeskeyHex, 'utf8').toString('base64');
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
  readonly cdnBaseUrl: string;

  constructor(
    readonly baseUrl = DEFAULT_BASE_URL,
    readonly token = '',
    cdnBaseUrl: string = CDN_BASE_URL,
  ) {
    this.cdnBaseUrl = cdnBaseUrl;
  }

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
    return this.sendMediaItem(
      toUserId,
      { type: MessageItemType.TEXT, text_item: { text } },
      contextToken,
    );
  }

  /**
   * Request a pre-signed CDN upload reference for a media file (iLink
   * `getuploadurl`). Returns `{ upload_param, thumb_upload_param }`; the
   * `upload_param` is the encrypted query param used to build the CDN URL.
   */
  async getUploadUrl(params: {
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
    noNeedThumb?: boolean;
  }): Promise<{ upload_param?: string; thumb_upload_param?: string }> {
    const resp = await this.post('ilink/bot/getuploadurl', {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: params.noNeedThumb ?? true,
      aeskey: params.aeskey,
    });
    return {
      upload_param: typeof resp.upload_param === 'string' ? resp.upload_param : undefined,
      thumb_upload_param: typeof resp.thumb_upload_param === 'string' ? resp.thumb_upload_param : undefined,
    };
  }

  /**
   * POST AES-128-ECB-encrypted bytes to the Weixin CDN. The CDN returns the
   * download reference via the `x-encrypted-param` response header.
   */
  async uploadBufferToCdn(
    buf: Buffer,
    uploadParam: string,
    filekey: string,
    aeskey: Buffer,
    timeoutMs = 60_000,
  ): Promise<string> {
    const ciphertext = encryptAesEcb(buf, aeskey);
    const url =
      `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
      `&filekey=${encodeURIComponent(filekey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text().catch(() => ''));
        throw new Error(`Weixin CDN upload ${res.status}: ${errMsg || res.statusText}`);
      }
      const downloadParam = res.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new Error('Weixin CDN upload response missing x-encrypted-param header');
      }
      return downloadParam;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Full upload pipeline: read file → md5 → gen aeskey → getUploadUrl →
   * encrypt → upload to CDN. Returns the info needed to reference the file
   * in an outbound image/file/video message.
   */
  async uploadMedia(
    filePath: string,
    toUserId: string,
    mediaType: number,
  ): Promise<UploadedFileInfo> {
    const plaintext = await fs.promises.readFile(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);
    const aeskeyHex = aeskey.toString('hex');

    const { upload_param } = await this.getUploadUrl({
      filekey,
      mediaType,
      toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskeyHex,
    });
    if (!upload_param) {
      throw new Error('Weixin getUploadUrl returned no upload_param');
    }
    const downloadEncryptedQueryParam = await this.uploadBufferToCdn(
      plaintext,
      upload_param,
      filekey,
      aeskey,
    );

    return {
      filekey,
      downloadEncryptedQueryParam,
      aeskey: aeskeyHex,
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
    };
  }

  /** Send a single media item (image/file/video) downstream. */
  async sendMediaItem(
    toUserId: string,
    item: Record<string, unknown>,
    contextToken: string,
  ): Promise<Record<string, unknown>> {
    return this.post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: randomUUID().replace(/-/g, '').slice(0, 16),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: contextToken,
      },
    });
  }

  /** Send an image message using a previously uploaded file. */
  async sendImageMessage(
    toUserId: string,
    uploaded: UploadedFileInfo,
    contextToken: string,
  ): Promise<Record<string, unknown>> {
    return this.sendMediaItem(
      toUserId,
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: encodeAesKeyField(uploaded.aeskey),
            encrypt_type: 1,
          },
          mid_size: uploaded.fileSizeCiphertext,
        },
      },
      contextToken,
    );
  }

  /** Send a file attachment using a previously uploaded file. */
  async sendFileMessage(
    toUserId: string,
    fileName: string,
    uploaded: UploadedFileInfo,
    contextToken: string,
  ): Promise<Record<string, unknown>> {
    return this.sendMediaItem(
      toUserId,
      {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: encodeAesKeyField(uploaded.aeskey),
            encrypt_type: 1,
          },
          file_name: fileName,
          len: String(uploaded.fileSize),
        },
      },
      contextToken,
    );
  }

  /** Send a video message using a previously uploaded file. */
  async sendVideoMessage(
    toUserId: string,
    uploaded: UploadedFileInfo,
    contextToken: string,
  ): Promise<Record<string, unknown>> {
    return this.sendMediaItem(
      toUserId,
      {
        type: MessageItemType.VIDEO,
        video_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: encodeAesKeyField(uploaded.aeskey),
            encrypt_type: 1,
          },
          video_size: uploaded.fileSizeCiphertext,
        },
      },
      contextToken,
    );
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
