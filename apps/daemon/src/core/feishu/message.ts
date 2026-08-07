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
 * goes through the authenticated message-resource endpoint
 * (`im/v1/messages/{message_id}/resources/{key}`), so each attachment carries
 * the event's `message_id`.
 */
function extractAttachments(event: FeishuRawEvent): FeishuAttachment[] {
  const msg = event.message;
  const parsed = parseContent(msg.content);
  if (!parsed) return [];
  const out: FeishuAttachment[] = [];
  const messageId = typeof msg.message_id === 'string' ? msg.message_id : '';

  if (msg.message_type === 'image') {
    const key = parsed.image_key;
    if (typeof key === 'string' && key) {
      out.push({ kind: 'image', key, messageId });
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
      messageId,
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
 *
 * Detects three shapes produced by `materializeWikiLinks` (daemon):
 * 1. Wiki 正文已抓回 → text starts with `# <title>` or `## 来源: <url>`.
 *    Frame the agent to read the embedded markdown (don't re-fetch the URL).
 * 2. 抓取失败但有 [注: ...] 提示 → tell the agent to surface the failure
 *    reason to the user.
 * 3. Plain mp.weixin article URL (unchanged legacy path) → frame the agent
 *    to fetch & summarize.
 */
export function buildFeishuPrompt(text: string): string {
  if (!text) return text;

  // Case 1: materializeWikiLinks injected a Markdown body.
  const hasInjectedMarkdown = /^#\s+\S/m.test(text) || /^##\s+来源:\s+https?/m.test(text);
  if (hasInjectedMarkdown) {
    return [
      '这是从飞书通道收到的消息，已附带抓取好的 Markdown 正文。请直接基于正文内容回答用户问题、总结要点，并询问是否需要保存到知识库。',
      '不要再去 fetch 链接 — 正文已经在下方提供。',
      '',
      text,
    ].join('\n');
  }

  // Case 2: materializeWikiLinks injected a failure note like
  // `<url>\n\n[注: ...]`. The note text starts with 「[注:」.
  if (/\n\s*\[注:/m.test(text) && /feishu\.cn|larksuite\.com/i.test(text)) {
    return [
      '这是从飞书通道收到的文档链接，但 Molio 未能自动抓取其正文（具体原因见下方 [注: ...] 说明）。',
      '请向用户简要说明发生了什么，并建议用户：① 在 Molio 设置 → 飞书渠道点击「登录飞书账号」登录对应租户，或 ② 在飞书内导出 Markdown / 截图后重发。',
      '',
      text,
    ].join('\n');
  }

  // Case 3 (legacy): mp.weixin article URL — let the agent fetch & summarize.
  if (!looksLikeArticleUrl(text)) return text;

  return [
    '这是从飞书通道收到的公众号文章链接或相关文本。',
    '请先识别其中的文章 URL，再根据内容帮助用户总结、提炼要点，并询问是否需要保存到知识库。',
    '',
    text,
  ].join('\n');
}
