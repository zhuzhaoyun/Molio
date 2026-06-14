import type { ParsedWeixinMessage, WeixinRawItem, WeixinRawMessage } from './types.js';

const ITEM_TEXT = 1;

function itemText(item: WeixinRawItem): string {
  if (item.type === ITEM_TEXT) {
    const text = item.text_item?.text;
    return typeof text === 'string' ? text : '';
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
  if (!text) return null;

  return {
    id: String(raw.message_id ?? raw.seq ?? `${fromUserId}:${Date.now()}`),
    fromUserId,
    toUserId: raw.to_user_id ?? '',
    contextToken: raw.context_token ?? '',
    text,
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
