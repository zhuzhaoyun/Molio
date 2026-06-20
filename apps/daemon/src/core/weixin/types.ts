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

export interface WeixinRawItem {
  type?: number;
  text_item?: { text?: string };
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

export interface ParsedWeixinMessage {
  id: string;
  fromUserId: string;
  toUserId: string;
  contextToken: string;
  text: string;
  raw: WeixinRawMessage;
}
