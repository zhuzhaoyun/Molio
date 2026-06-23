import type { ParsedWeixinMessage, WeixinAttachment, WeixinRawItem, WeixinRawMessage } from './types.js';

const ITEM_TEXT = 1;

function formatFileSize(bytes: number): string {
  if (Number.isNaN(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Extract a directly-downloadable URL from a media descriptor, if present. */
function mediaUrl(item: WeixinRawItem): string | undefined {
  const file = item.file_item;
  if (file) {
    const full = file.media?.full_url;
    if (typeof full === 'string' && full) return full;
    if (typeof file.file_url === 'string' && file.file_url) return file.file_url;
    if (typeof file.url === 'string' && file.url) return file.url;
    return undefined;
  }
  const image = item.image_item;
  if (image) {
    const full = image.media?.full_url;
    if (typeof full === 'string' && full) return full;
    if (typeof image.image_url === 'string' && image.image_url) return image.image_url;
    if (typeof image.url === 'string' && image.url) return image.url;
    if (typeof image.file_url === 'string' && image.file_url) return image.file_url;
    if (typeof image.cdn_url === 'string' && image.cdn_url) return image.cdn_url;
    return undefined;
  }
  return undefined;
}

/** Collect downloadable attachments from an item list. */
export function extractAttachments(items: WeixinRawItem[] | undefined): WeixinAttachment[] {
  if (!Array.isArray(items)) return [];
  const out: WeixinAttachment[] = [];
  for (const item of items) {
    if (item.file_item) {
      const url = mediaUrl(item);
      if (!url) continue;
      const sizeRaw = item.file_item.file_size ?? item.file_item.len;
      const size = typeof sizeRaw === 'number' ? sizeRaw : typeof sizeRaw === 'string' ? Number(sizeRaw) || undefined : undefined;
      out.push({
        kind: 'file',
        url,
        fileName: item.file_item.file_name ?? item.file_item.title,
        size,
        aesKey: item.file_item.media?.aes_key,
      });
    } else if (item.image_item) {
      const url = mediaUrl(item);
      if (!url) continue;
      out.push({
        kind: 'image',
        url,
        width: item.image_item.width ?? item.image_item.thumb_width,
        height: item.image_item.height ?? item.image_item.thumb_height,
        size: item.image_item.hd_size ?? item.image_item.mid_size,
        aesKey: item.image_item.aeskey ?? item.image_item.media?.aes_key,
      });
    }
  }
  return out;
}

function fileItemText(item: WeixinRawItem): string {
  const file = item.file_item;
  if (!file) return '';

  const name = typeof file.file_name === 'string' ? file.file_name : file.title;
  if (typeof name !== 'string' || !name.trim()) return '';

  const parts: string[] = [];
  const sizeRaw = file.file_size ?? file.len;
  const size = typeof sizeRaw === 'number' ? sizeRaw : typeof sizeRaw === 'string' ? Number(sizeRaw) || undefined : undefined;
  if (typeof size === 'number') {
    parts.push(`大小: ${formatFileSize(size)}`);
  }
  const url = mediaUrl(item);
  if (url) parts.push(`链接: ${url}`);

  const header = parts.length > 0 ? `[文件] ${name} (${parts.join(', ')})` : `[文件] ${name}`;
  return header;
}

function imageItemText(item: WeixinRawItem): string {
  const image = item.image_item;
  if (!image) return '';

  const url = mediaUrl(item);

  const parts: string[] = [];
  if (url) parts.push(`链接: ${url}`);
  const width = image.width ?? image.thumb_width;
  const height = image.height ?? image.thumb_height;
  if (typeof width === 'number') parts.push(`宽: ${width}`);
  if (typeof height === 'number') parts.push(`高: ${height}`);

  return parts.length > 0 ? `[图片] (${parts.join(', ')})` : '[图片]';
}

function itemText(item: WeixinRawItem): string {
  if (item.type === ITEM_TEXT) {
    const text = item.text_item?.text;
    return typeof text === 'string' ? text : '';
  }

  if (item.file_item) {
    return fileItemText(item);
  }

  if (item.image_item) {
    return imageItemText(item);
  }

  const ref = item.ref_msg;
  if (!ref) return '';

  const title = typeof ref.title === 'string' ? ref.title : '';
  const refBody = ref.message_item ? itemText(ref.message_item) : '';
  return [title, refBody].filter(Boolean).join('\n');
}

export function parseWeixinMessage(raw: WeixinRawMessage): ParsedWeixinMessage | null {
  const fromUserId = raw.from_user_id;
  if (!fromUserId) return null;

  const itemList = Array.isArray(raw.item_list) ? raw.item_list : [];
  const text = itemList.map(itemText).filter(Boolean).join('\n').trim();
  const attachments = extractAttachments(itemList);
  if (!text && attachments.length === 0) return null;

  return {
    id: String(raw.message_id ?? raw.seq ?? `${fromUserId}:${Date.now()}`),
    fromUserId,
    toUserId: raw.to_user_id ?? '',
    contextToken: raw.context_token ?? '',
    text,
    attachments,
    raw,
  };
}

export function looksLikeArticleUrl(text: string): boolean {
  return /https?:\/\/mp\.weixin\.qq\.com\/[^\s]+/i.test(text);
}

export function buildMolioPrompt(text: string): string {
  if (!looksLikeArticleUrl(text)) return text;

  return [
    '这是从微信 ClawBot 通道收到的公众号文章链接或相关文本。',
    '请先识别其中的文章 URL，再根据内容帮助用户总结、提炼要点，并询问是否需要保存到知识库。',
    '',
    text,
  ].join('\n');
}
