export type WeixinLoginStatus = 'idle' | 'waiting_scan' | 'scanned' | 'logged_in' | 'error';

// ConnectionState and OutboundMediaItem are shared across channels — re-export
// from the cross-channel types module so existing callers keep importing from
// 'weixin/types' without breakage. New code should import from
// 'core/channels/types' directly.
import type { ConnectionState } from '../channels/types.js';
export type { ConnectionState, OutboundMediaItem } from '../channels/types.js';

/** Weixin CDN base URL for media upload/download. */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** proto: UploadMediaType — selects the CDN upload lane in `getuploadurl`. */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

/** proto: MessageItemType — the `type` discriminator on each `item_list` entry. */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** proto: MessageType / MessageState for outbound BOT messages. */
export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

/**
 * Result of uploading a local file to the Weixin CDN. The
 * `downloadEncryptedQueryParam` is the CDN reference placed into
 * `media.encrypt_query_param` when composing the outbound message.
 */
export interface UploadedFileInfo {
  /** Random 32-char hex id used in the upload URL. */
  filekey: string;
  /** CDN-returned download param (from the `x-encrypted-param` header). */
  downloadEncryptedQueryParam: string;
  /** AES-128-ECB key, hex-encoded (16 bytes). */
  aeskey: string;
  /** Plaintext file size in bytes. */
  fileSize: number;
  /** Ciphertext file size (AES-128-ECB + PKCS7); used for hd_size/mid_size. */
  fileSizeCiphertext: number;
}

export interface WeixinCredentials {
  token: string;
  baseUrl: string;
  botId?: string;
  userId?: string;
  contextTokens?: Record<string, string>;
}

export interface WeixinStatus {
  enabled: boolean;
  loginStatus: WeixinLoginStatus;
  connected: boolean;
  qrcodeUrl: string;
  lastError: string | null;
  lastMessageAt: number | null;
  activeRunId: string | null;
  hasCredentials: boolean;
  /** Detailed connection state for auto-reconnect diagnostics. */
  connectionState?: ConnectionState;
}

/** Downloadable media descriptor shared by file_item and image_item. */
export interface WeixinMedia {
  /** Signed, directly-downloadable CDN URL (no extra auth needed). */
  full_url?: string;
  encrypt_query_param?: string;
  aes_key?: string;
}

export interface WeixinFileItem {
  file_name?: string;
  title?: string;
  file_size?: number;
  file_url?: string;
  url?: string;
  file_id?: string;
  mime_type?: string;
  /** iLink bot API: the real downloadable media descriptor. */
  media?: WeixinMedia;
  md5?: string;
  /** File length in bytes (may arrive as string). */
  len?: string | number;
}

export interface WeixinImageItem {
  /** Legacy/generic fields kept for forward-compat with other API shapes. */
  url?: string;
  image_url?: string;
  file_url?: string;
  cdn_url?: string;
  width?: number;
  height?: number;
  /** iLink bot API: the real downloadable media descriptor. */
  aeskey?: string;
  media?: WeixinMedia;
  mid_size?: number;
  hd_size?: number;
  thumb_size?: number;
  thumb_width?: number;
  thumb_height?: number;
}

export interface WeixinRawItem {
  type?: number;
  text_item?: { text?: string };
  file_item?: WeixinFileItem;
  image_item?: WeixinImageItem;
  ref_msg?: {
    title?: string;
    message_item?: WeixinRawItem;
  };
  [key: string]: unknown;
}

export interface WeixinRawMessage {
  message_id?: string | number;
  seq?: string | number;
  message_type?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  item_list?: WeixinRawItem[];
  [key: string]: unknown;
}

/** A downloadable media attachment extracted from a WeChat message. */
export interface WeixinAttachment {
  kind: 'file' | 'image';
  /** Signed CDN URL — directly fetchable, no extra auth. */
  url: string;
  /** Best-effort file name (may be missing for images). */
  fileName?: string;
  /** Bytes, when known. */
  size?: number;
  /** Dimensions for images. */
  width?: number;
  height?: number;
  /** AES key for decrypting the downloaded ciphertext (hex or base64). */
  aesKey?: string;
}

export interface ParsedWeixinMessage {
  id: string;
  fromUserId: string;
  toUserId: string;
  contextToken: string;
  text: string;
  raw: WeixinRawMessage;
  /** Downloadable file/image attachments extracted from item_list. */
  attachments?: WeixinAttachment[];
}
