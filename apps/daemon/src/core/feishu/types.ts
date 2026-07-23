import type { ConnectionState } from '../channels/types.js';

/** Feishu bot connection state — mirrors weixin's state machine for parity. */
export type FeishuLoginStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** Downloaded/cached Feishu app credentials (tenant_access_token + expiry). */
export interface FeishuCredentials {
  /** Tenant access token — used as `Authorization: Bearer <token>` on Feishu APIs. */
  tenantAccessToken: string;
  /** Absolute ms timestamp when the token expires (2h validity per Feishu spec). */
  expiresAt: number;
}

/** Per-message parsed Feishu attachment (image/file) extracted from `im.message.receive_v1`. */
export interface FeishuAttachment {
  kind: 'file' | 'image';
  /** Feishu file_key or image_key — used to download via im/v1/files or im/v1/images. */
  key: string;
  /** Best-effort file name (may be missing for images). */
  fileName?: string;
}

/**
 * Normalized Feishu message handed to the channel dispatcher.
 *
 * Feishu's `im.message.receive_v1` event payload has a deeply nested shape; this
 * flattened view is what `FeishuService.createMolioRun` consumes. `fromUserId`
 * is the sender's `open_id` (used both as the conversation key and the reply
 * target).
 */
export interface ParsedFeishuMessage {
  /** Unique message id — used for dedup (Feishu guarantees idempotency on retries). */
  id: string;
  /** Sender's open_id (the user who DM'd or @-mentioned the bot). */
  fromUserId: string;
  /** Chat id — kept for diagnostics; replies go via `receive_id_type=open_id`. */
  chatId?: string;
  /** 'p2p' | 'group' — group messages are out of scope for v1 (we only handle DMs). */
  chatType?: string;
  /** Parsed user-visible text (text content for text messages; descriptor for media). */
  text: string;
  /** Downloadable attachments extracted from the event payload (image/file). */
  attachments?: FeishuAttachment[];
  /** Original event payload — kept for forward-compat (e.g. mentions parsing). */
  raw: unknown;
}

export interface FeishuStatus {
  enabled: boolean;
  loginStatus: FeishuLoginStatus;
  connected: boolean;
  lastError: string | null;
  lastMessageAt: number | null;
  activeRunId: string | null;
  hasCredentials: boolean;
  /** App id configured — surfaced in status so the wizard UI can echo it back. */
  hasAppConfig: boolean;
  connectionState?: ConnectionState;
}

/**
 * Raw payload of `im.message.receive_v1` event from the Lark SDK's WSClient.
 *
 * The shape comes from Feishu's official event schema (see SDK types:
 * `sender.sender_id.open_id`, `message.message_id`, `message.message_type`,
 * `message.content` as a JSON string). We keep it loose (`unknown`) at the
 * boundary and parse defensively in `parseFeishuMessage` — Feishu occasionally
 * sends extra fields or reshapes optional ones between versions.
 */
export type FeishuRawEvent = {
  event_id?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string; union_id?: string };
      name: string;
    }>;
  };
};
