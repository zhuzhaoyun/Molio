import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeishuPrompt,
  looksLikeArticleUrl,
  parseFeishuMessage,
} from '../../../src/core/feishu/message.js';
import type { FeishuRawEvent } from '../../../src/core/feishu/types.js';

function textEvent(overrides?: Partial<FeishuRawEvent>): FeishuRawEvent {
  return {
    event_id: 'evt-1',
    sender: {
      sender_id: { open_id: 'ou_test_user' },
      sender_type: 'user',
    },
    message: {
      message_id: 'msg-1',
      create_time: String(Date.now()),
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello world' }),
    },
    ...overrides,
  };
}

describe('parseFeishuMessage', () => {
  it('parses a plain text message', () => {
    const parsed = parseFeishuMessage(textEvent());
    assert.ok(parsed);
    assert.equal(parsed?.id, 'msg-1');
    assert.equal(parsed?.fromUserId, 'ou_test_user');
    assert.equal(parsed?.chatId, 'oc_test_chat');
    assert.equal(parsed?.chatType, 'p2p');
    assert.equal(parsed?.text, 'hello world');
    assert.deepEqual(parsed?.attachments ?? [], []);
  });

  it('extracts an image attachment by image_key', () => {
    const event = textEvent({
      message: {
        message_id: 'msg-2',
        create_time: String(Date.now()),
        chat_id: 'oc_test_chat',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_test_key' }),
      },
    });
    const parsed = parseFeishuMessage(event);
    assert.ok(parsed);
    assert.equal(parsed?.attachments?.length, 1);
    const att = parsed?.attachments?.[0];
    assert.equal(att?.kind, 'image');
    assert.equal(att?.key, 'img_test_key');
    assert.match(parsed?.text ?? '', /img_test_key/);
  });

  it('extracts a file attachment with file_name', () => {
    const event = textEvent({
      message: {
        message_id: 'msg-3',
        create_time: String(Date.now()),
        chat_id: 'oc_test_chat',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_test_key', file_name: 'report.pdf' }),
      },
    });
    const parsed = parseFeishuMessage(event);
    assert.ok(parsed);
    assert.equal(parsed?.attachments?.length, 1);
    const att = parsed?.attachments?.[0];
    assert.equal(att?.kind, 'file');
    assert.equal(att?.key, 'file_test_key');
    assert.equal(att?.fileName, 'report.pdf');
    assert.match(parsed?.text ?? '', /report\.pdf/);
    assert.match(parsed?.text ?? '', /file_test_key/);
  });

  it('returns null when sender open_id is missing', () => {
    const event = textEvent({
      sender: { sender_id: {}, sender_type: 'user' },
    });
    assert.equal(parseFeishuMessage(event), null);
  });

  it('falls back to a placeholder for unsupported message_type', () => {
    const event = textEvent({
      message: {
        message_id: 'msg-4',
        create_time: String(Date.now()),
        chat_id: 'oc_test_chat',
        chat_type: 'p2p',
        message_type: 'share_chat',
        content: '{}',
      },
    });
    const parsed = parseFeishuMessage(event);
    assert.ok(parsed);
    assert.match(parsed?.text ?? '', /不支持的消息类型/);
  });

  it('uses event_id when message_id is missing', () => {
    const event = textEvent({
      event_id: 'evt-fallback',
      message: {
        message_id: '',
        create_time: String(Date.now()),
        chat_id: 'oc_test_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      } as FeishuRawEvent['message'],
    });
    const parsed = parseFeishuMessage(event);
    assert.equal(parsed?.id, 'evt-fallback');
  });
});

describe('looksLikeArticleUrl', () => {
  it('matches a weixin mp article URL', () => {
    assert.ok(looksLikeArticleUrl('看看这篇 https://mp.weixin.qq.com/s?__biz=abc 文章'));
  });

  it('does not match a non-weixin URL', () => {
    assert.ok(!looksLikeArticleUrl('https://example.com/article'));
  });
});

describe('buildFeishuPrompt', () => {
  it('wraps an article URL with the feishu context preface', () => {
    const text = 'https://mp.weixin.qq.com/s?__biz=abc';
    const prompt = buildFeishuPrompt(text);
    assert.ok(prompt.includes('飞书通道'));
    assert.ok(prompt.includes(text));
  });

  it('returns text unchanged when no article URL is present', () => {
    const text = '今天天气如何';
    assert.equal(buildFeishuPrompt(text), text);
  });

  it('frames injected markdown (success path) — tells agent not to re-fetch', () => {
    const text = [
      '## 来源: https://geekbang.feishu.cn/wiki/AbC123',
      '',
      '# 飞书文档标题',
      '',
      '正文段落。',
    ].join('\n');
    const prompt = buildFeishuPrompt(text);
    assert.ok(prompt.includes('已附带抓取好的 Markdown 正文'));
    assert.ok(prompt.includes('不要再去 fetch'));
    assert.ok(prompt.includes(text));
  });

  it('frames the fetch-failure note — tells agent to surface the reason', () => {
    const text = [
      'https://geekbang.feishu.cn/wiki/AbC123',
      '',
      '[注: 检测到未登录该飞书租户，请在 Molio 设置 → 飞书渠道 → 登录飞书账号，登录后重试]',
    ].join('\n');
    const prompt = buildFeishuPrompt(text);
    assert.ok(prompt.includes('未能自动抓取其正文'));
    assert.ok(prompt.includes('登录飞书账号'));
    assert.ok(prompt.includes(text));
  });
});
