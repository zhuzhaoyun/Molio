import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAttachments, parseWeixinMessage } from '../../../src/core/weixin/message.js';
import type { WeixinRawMessage } from '../../../src/core/weixin/types.js';

const FULL_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc&taskid=123';

describe('parseWeixinMessage', () => {
  it('parses a plain text message with no attachments', () => {
    const raw: WeixinRawMessage = {
      message_id: 'msg-1',
      from_user_id: 'user-1',
      to_user_id: 'bot-1',
      context_token: 'token-1',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'Hello' } }],
    };

    const parsed = parseWeixinMessage(raw);

    assert.ok(parsed);
    assert.equal(parsed?.text, 'Hello');
    assert.equal(parsed?.fromUserId, 'user-1');
    assert.equal(parsed?.contextToken, 'token-1');
    assert.deepEqual(parsed?.attachments ?? [], []);
  });

  it('parses a file message using media.full_url and extracts an attachment', () => {
    const raw: WeixinRawMessage = {
      message_id: 'msg-2',
      from_user_id: 'user-1',
      to_user_id: 'bot-1',
      message_type: 1,
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: 'report.pdf',
            len: '446606',
            md5: 'abc',
            media: { full_url: FULL_URL, aes_key: 'NDBjZmRiN2RhZDhmODc1ODI5NjA2NjZmNThmMDMwNDg=' },
          },
        },
      ],
    };

    const parsed = parseWeixinMessage(raw);

    assert.ok(parsed);
    assert.match(parsed?.text ?? '', /report\.pdf/);
    assert.match(parsed?.text ?? '', /链接: /);
    assert.equal(parsed?.attachments?.length, 1);
    const att = parsed?.attachments?.[0];
    assert.equal(att?.kind, 'file');
    assert.equal(att?.url, FULL_URL);
    assert.equal(att?.fileName, 'report.pdf');
    assert.equal(att?.size, 446606);
    assert.equal(att?.aesKey, 'NDBjZmRiN2RhZDhmODc1ODI5NjA2NjZmNThmMDMwNDg=');
  });

  it('parses an image message using media.full_url and extracts an attachment', () => {
    const raw: WeixinRawMessage = {
      message_id: 'msg-3',
      from_user_id: 'user-1',
      to_user_id: 'bot-1',
      message_type: 1,
      item_list: [
        {
          type: 2,
          image_item: {
            aeskey: '24dae86aeb24d7a2069b7b852dec5bc3',
            media: { full_url: FULL_URL, aes_key: 'MjRkYWU4NmFlYjI0ZDdhMjA2OWI3Yjg1MmRlYzViYzM=' },
            mid_size: 473442,
            hd_size: 473442,
            thumb_width: 94,
            thumb_height: 210,
          },
        },
      ],
    };

    const parsed = parseWeixinMessage(raw);

    assert.ok(parsed);
    assert.match(parsed?.text ?? '', /图片/);
    assert.match(parsed?.text ?? '', /链接: /);
    assert.match(parsed?.text ?? '', /宽: 94/);
    assert.match(parsed?.text ?? '', /高: 210/);
    assert.equal(parsed?.attachments?.length, 1);
    const att = parsed?.attachments?.[0];
    assert.equal(att?.kind, 'image');
    assert.equal(att?.url, FULL_URL);
    assert.equal(att?.width, 94);
    assert.equal(att?.height, 210);
    assert.equal(att?.size, 473442);
    // aeskey (hex) is preferred over media.aes_key (b64)
    assert.equal(att?.aesKey, '24dae86aeb24d7a2069b7b852dec5bc3');
  });

  it('still parses a file message even when message_type is not 1', () => {
    const raw: WeixinRawMessage = {
      message_id: 'msg-4',
      from_user_id: 'user-1',
      message_type: 3,
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: 'notes.pdf',
            file_size: 1024,
            media: { full_url: FULL_URL },
          },
        },
      ],
    };

    const parsed = parseWeixinMessage(raw);

    assert.ok(parsed);
    assert.match(parsed?.text ?? '', /notes\.pdf/);
    assert.equal(parsed?.attachments?.length, 1);
  });

  it('ignores items without extractable content or media', () => {
    const raw: WeixinRawMessage = {
      message_id: 'msg-5',
      from_user_id: 'user-1',
      message_type: 1,
      item_list: [{ type: 99 }],
    };

    const parsed = parseWeixinMessage(raw);

    assert.equal(parsed, null);
  });

  it('returns null when from_user_id is missing', () => {
    const raw: WeixinRawMessage = {
      message_id: 'msg-6',
      item_list: [{ type: 1, text_item: { text: 'Hello' } }],
    };

    const parsed = parseWeixinMessage(raw);

    assert.equal(parsed, null);
  });
});

describe('extractAttachments', () => {
  it('returns empty for a text-only item list', () => {
    const items = [{ type: 1, text_item: { text: 'hi' } }];
    assert.deepEqual(extractAttachments(items), []);
  });

  it('collects both file and image attachments in order', () => {
    const items = [
      { type: 4, file_item: { file_name: 'a.pdf', media: { full_url: FULL_URL } } },
      { type: 2, image_item: { media: { full_url: FULL_URL } } },
    ];
    const result = extractAttachments(items);
    assert.equal(result.length, 2);
    assert.equal(result[0]?.kind, 'file');
    assert.equal(result[0]?.fileName, 'a.pdf');
    assert.equal(result[1]?.kind, 'image');
  });

  it('skips items whose media has no URL', () => {
    const items = [{ type: 4, file_item: { file_name: 'a.pdf' } }];
    assert.deepEqual(extractAttachments(items), []);
  });
});
