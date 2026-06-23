export type WeixinLoginStatus = 'idle' | 'waiting_scan' | 'scanned' | 'logged_in' | 'error';

/** Internal connection state machine states. */
export type ConnectionState = 'idle' | 'connecting' | 'polling' | 'unhealthy' | 'expired';

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
