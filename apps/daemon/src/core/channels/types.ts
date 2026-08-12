/**
 * Shared types across external channels (weixin, feishu, future wecom).
 *
 * Channel modules each own their own protocol-specific types (FeishuRawEvent,
 * WeixinRawMessage, etc.), but the cross-channel contract — what a channel
 * emits to the dispatcher and what the dispatcher hands back to a channel —
 * lives here so the dispatcher can be channel-agnostic.
 */

/**
 * Internal connection state machine states (shared across channels).
 *
 * Not every channel uses every state:
 * - weixin uses `idle/connecting/polling/unhealthy/expired` (poll-based).
 * - feishu uses `idle/connecting/connected/reconnecting/error` (WS-based).
 *
 * The union is shared so the dispatcher and status types stay channel-agnostic;
 * individual channels surface only the states they actually transition through.
 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'polling'
  | 'unhealthy'
  | 'expired'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * A local file the AI produced this turn that should be delivered to the IM
 * channel as a real attachment (image/file/video).
 */
export interface OutboundMediaItem {
  /** Absolute local file path. */
  filePath: string;
  /** Best-effort file name (basename). */
  fileName: string;
  /** Delivery channel: image, file, or video. */
  kind: 'image' | 'file' | 'video';
}

/**
 * Sink interface a channel implements so the shared `ChannelDispatcher` can
 * push replies back without knowing which IM it's talking to. Each channel
 * constructs its own dispatcher with `sink: this`.
 */
export interface ChannelSink {
  /** Send a text reply chunk to the user. */
  sendText(toUserId: string, text: string): Promise<void>;
  /** Send a media file attachment (image/file/video). */
  sendMediaFile(toUserId: string, item: OutboundMediaItem): Promise<void>;
  /** Notify the channel when the active run changes (e.g. for status display). */
  onActiveRun?(runId: string | null): void;
}
