import type { FeishuAttachment, FeishuRawEvent, ParsedFeishuMessage } from './types.js';

/**
 * Parse `im.message.receive_v1` content payload (a JSON string) into a
 * structured object. Feishu sends `message.content` as a JSON-encoded string
 * even for text messages (e.g. `{"text":"hello"}`), so we parse defensively.
 */
function parseContent(content: string): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function textContent(content: string): string {
  const parsed = parseContent(content);
  if (!parsed) return '';
  const text = parsed.text;
  return typeof text === 'string' ? text : '';
}

/**
 * Extract downloadable attachments (image/file) from a Feishu message payload.
 * Feishu returns `image_key`/`file_key` rather than direct URLs; download
 * goes through the authenticated `im/v1/images` / `im/v1/files` endpoints.
 */
function extractAttachments(event: FeishuRawEvent): FeishuAttachment[] {
  const msg = event.message;
  const parsed = parseContent(msg.content);
  if (!parsed) return [];
  const out: FeishuAttachment[] = [];

  if (msg.message_type === 'image') {
    const key = parsed.image_key;
    if (typeof key === 'string' && key) {
      out.push({ kind: 'image', key });
    }
    return out;
  }

  if (msg.message_type === 'file') {
    const key = parsed.file_key;
    if (typeof key !== 'string' || !key) return out;
    const fileName = parsed.file_name;
    out.push({
      kind: 'file',
      key,
      fileName: typeof fileName === 'string' ? fileName : undefined,
    });
    return out;
  }

  return out;
}

/**
 * Describe a media attachment for the user-visible text. The agent sees this
 * placeholder before downloads are materialized; once downloaded, the path
 * replaces the descriptor (see `materializeFeishuAttachments`).
 */
function attachmentDescriptor(att: FeishuAttachment): string {
  if (att.kind === 'image') {
    return `[图片] image_key: ${att.key}`;
  }
  const name = att.fileName ?? att.key;
  return `[文件] ${name} file_key: ${att.key}`;
}

/**
 * Parse a raw `im.message.receive_v1` event into the flattened
 * `ParsedFeishuMessage` shape that `FeishuService.createMolioRun` consumes.
 * Returns `null` for events with no sender open_id or no usable content
 * (so the dispatcher can skip silently rather than spawn an empty run).
 */
export function parseFeishuMessage(event: FeishuRawEvent): ParsedFeishuMessage | null {
  const openId = event.sender?.sender_id?.open_id;
  if (typeof openId !== 'string' || !openId) return null;

  const msg = event.message;
  const attachments = extractAttachments(event);

  let text: string;
  if (msg.message_type === 'text') {
    text = textContent(msg.content);
  } else if (attachments.length > 0) {
    text = attachments.map(attachmentDescriptor).join('\n');
  } else {
    // Unknown message_type (e.g. post, share_chat, sticker) — surface a
    // best-effort descriptor so the agent can still reply with guidance.
    text = `[不支持的消息类型: ${msg.message_type}]`;
  }

  if (!text && attachments.length === 0) return null;

  return {
    id: msg.message_id || event.event_id || `${openId}:${Date.now()}`,
    fromUserId: openId,
    chatId: msg.chat_id,
    chatType: msg.chat_type,
    text,
    attachments,
    raw: event,
  };
}

/** Whether a text looks like a WeChat mp.weixin.qq.com article URL. */
export function looksLikeArticleUrl(text: string): boolean {
  return /https?:\/\/mp\.weixin\.qq\.com\/[^\s]+/i.test(text);
}

/**
 * Wrap the raw user text with the feishu-channel context frame. Kept
 * symmetrical with `weixin/message.ts:buildMolioPrompt` so the wiki-article
 * extraction path stays identical across channels.
 */
export function buildFeishuPrompt(text: string): string {
  if (!looksLikeArticleUrl(text)) return text;

  return [
    '这是从飞书通道收到的公众号文章链接或相关文本。',
    '请先识别其中的文章 URL，再根据内容帮助用户总结、提炼要点，并询问是否需要保存到知识库。',
    '',
    text,
  ].join('\n');
}
