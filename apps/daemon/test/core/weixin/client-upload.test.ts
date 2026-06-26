import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WeixinApi,
  aesEcbPaddedSize,
  encryptAesEcb,
  encodeAesKeyField,
} from '../../../src/core/weixin/client.js';
import { UploadMediaType } from '../../../src/core/weixin/types.js';

/** Decrypt AES-128-ECB with PKCS7 padding (default auto-padding strips it). */
function decryptAesEcb(cipher: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

describe('weixin client crypto helpers', () => {
  it('aesEcbPaddedSize rounds up to 16-byte boundary with PKCS7', () => {
    assert.equal(aesEcbPaddedSize(0), 16);
    assert.equal(aesEcbPaddedSize(1), 16);
    assert.equal(aesEcbPaddedSize(15), 16);
    assert.equal(aesEcbPaddedSize(16), 32);
    assert.equal(aesEcbPaddedSize(17), 32);
    assert.equal(aesEcbPaddedSize(32), 48);
  });

  it('encryptAesEcb round-trips with decrypt', () => {
    const key = crypto.randomBytes(16);
    const plain = Buffer.from('hello weixin media', 'utf8');
    const cipher = encryptAesEcb(plain, key);
    assert.equal(cipher.length, aesEcbPaddedSize(plain.length));
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    const back = Buffer.concat([decipher.update(cipher), decipher.final()]);
    assert.equal(back.toString('utf8'), 'hello weixin media');
  });

  it('encodeAesKeyField returns base64 of the hex-string bytes', () => {
    const hex = '40cfdb7dad8f87582960666f58f03048';
    const encoded = encodeAesKeyField(hex);
    // base64 of the UTF-8 bytes of the hex string — matches inbound media.aes_key
    assert.equal(encoded, Buffer.from(hex, 'utf8').toString('base64'));
  });
});

describe('WeixinApi media upload & send', () => {
  let tempDir: string;
  let originalFetch: typeof globalThis.fetch;
  let captured: {
    getUploadUrlBody?: Record<string, unknown>;
    cdnUrl?: string;
    cdnBody?: Buffer;
    sendMessageBodies: Record<string, unknown>[];
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-upload-'));
    originalFetch = globalThis.fetch;
    captured = { sendMessageBodies: [] };
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url?: string } | undefined)?.url ?? '';

      // getuploadurl → return upload_param
      if (url.includes('ilink/bot/getuploadurl')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        captured.getUploadUrlBody = body;
        return new Response(JSON.stringify({ ret: 0, upload_param: 'up-param-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      // CDN upload → read body, return download param via header
      if (url.includes('/upload?')) {
        captured.cdnUrl = url;
        const bodyBuf = Buffer.from(init?.body instanceof Uint8Array ? init.body : new Uint8Array());
        captured.cdnBody = bodyBuf;
        return new Response('', {
          status: 200,
          headers: { 'x-encrypted-param': 'dl-param-456' },
        });
      }

      // sendmessage → capture body, return success
      if (url.includes('ilink/bot/sendmessage')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        captured.sendMessageBodies.push(body);
        return new Response(JSON.stringify({ ret: 0, errcode: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uploadMedia encrypts the file and returns CDN download info', async () => {
    const api = new WeixinApi('https://ilinkai.weixin.qq.com/', 'test-token');
    const plain = Buffer.from('PDF-1.4 body content here', 'utf8');
    const filePath = join(tempDir, 'report.pdf');
    writeFileSync(filePath, plain);

    const uploaded = await api.uploadMedia(filePath, 'user-1', UploadMediaType.FILE);

    // Correct media type + sizes reported to getUploadUrl
    assert.equal(captured.getUploadUrlBody?.media_type, UploadMediaType.FILE);
    assert.equal(captured.getUploadUrlBody?.to_user_id, 'user-1');
    assert.equal(captured.getUploadUrlBody?.rawsize, plain.length);
    assert.equal(captured.getUploadUrlBody?.filesize, aesEcbPaddedSize(plain.length));
    assert.equal(captured.getUploadUrlBody?.no_need_thumb, true);
    assert.match(String(captured.getUploadUrlBody?.aeskey), /^[0-9a-f]{32}$/);

    // CDN URL references the upload_param + filekey
    assert.match(captured.cdnUrl ?? '', /upload\?encrypted_query_param=up-param-123/);
    assert.match(captured.cdnUrl ?? '', /filekey=/);

    // Uploaded ciphertext decrypts back to the original file content
    const aeskeyHex = String(captured.getUploadUrlBody?.aeskey);
    const decrypted = decryptAesEcb(captured.cdnBody!, aeskeyHex);
    assert.equal(decrypted.toString('utf8'), plain.toString('utf8'));

    // Returned info references the CDN download param + correct sizes
    assert.equal(uploaded.downloadEncryptedQueryParam, 'dl-param-456');
    assert.equal(uploaded.fileSize, plain.length);
    assert.equal(uploaded.fileSizeCiphertext, aesEcbPaddedSize(plain.length));
    assert.match(uploaded.filekey, /^[0-9a-f]{32}$/);
  });

  it('sendImageMessage composes the correct image_item', async () => {
    const api = new WeixinApi('https://ilinkai.weixin.qq.com/', 'tok');
    const uploaded = {
      filekey: 'fk',
      downloadEncryptedQueryParam: 'dl-param',
      aeskey: '40cfdb7dad8f87582960666f58f03048',
      fileSize: 100,
      fileSizeCiphertext: 112,
    };
    await api.sendImageMessage('user-2', uploaded, 'ctx-tok');

    const body = captured.sendMessageBodies[0];
    assert.ok(body, 'sendmessage body should be captured');
    const msg = body!.msg as Record<string, unknown>;
    const item = (msg.item_list as unknown[])[0] as Record<string, unknown>;
    assert.equal(item.type, 2); // IMAGE
    const imageItem = item.image_item as Record<string, unknown>;
    const media = imageItem.media as Record<string, unknown>;
    assert.equal(media.encrypt_query_param, 'dl-param');
    assert.equal(media.aes_key, encodeAesKeyField(uploaded.aeskey));
    assert.equal(media.encrypt_type, 1);
    assert.equal(imageItem.mid_size, 112);
    assert.equal(msg.context_token, 'ctx-tok');
    assert.equal(msg.to_user_id, 'user-2');
  });

  it('sendFileMessage composes the correct file_item with name and len', async () => {
    const api = new WeixinApi('https://ilinkai.weixin.qq.com/', 'tok');
    const uploaded = {
      filekey: 'fk',
      downloadEncryptedQueryParam: 'dl-param',
      aeskey: '40cfdb7dad8f87582960666f58f03048',
      fileSize: 4096,
      fileSizeCiphertext: 4112,
    };
    await api.sendFileMessage('user-3', 'notes.txt', uploaded, 'ctx-tok');

    const body = captured.sendMessageBodies[0];
    assert.ok(body, 'sendmessage body should be captured');
    const msg = body!.msg as Record<string, unknown>;
    const item = (msg.item_list as unknown[])[0] as Record<string, unknown>;
    assert.equal(item.type, 4); // FILE
    const fileItem = item.file_item as Record<string, unknown>;
    assert.equal(fileItem.file_name, 'notes.txt');
    assert.equal(fileItem.len, '4096');
    assert.equal((fileItem.media as Record<string, unknown>).encrypt_query_param, 'dl-param');
  });

  it('sendVideoMessage composes the correct video_item', async () => {
    const api = new WeixinApi('https://ilinkai.weixin.qq.com/', 'tok');
    const uploaded = {
      filekey: 'fk',
      downloadEncryptedQueryParam: 'dl-param',
      aeskey: '40cfdb7dad8f87582960666f58f03048',
      fileSize: 5000,
      fileSizeCiphertext: 5008,
    };
    await api.sendVideoMessage('user-4', uploaded, 'ctx-tok');

    const body = captured.sendMessageBodies[0];
    assert.ok(body, 'sendmessage body should be captured');
    const msg = body!.msg as Record<string, unknown>;
    const item = (msg.item_list as unknown[])[0] as Record<string, unknown>;
    assert.equal(item.type, 5); // VIDEO
    const videoItem = item.video_item as Record<string, unknown>;
    assert.equal(videoItem.video_size, 5008);
  });

  it('uploadBufferToCdn throws when x-encrypted-param header is missing', async () => {
    globalThis.fetch = (async () =>
      new Response('', { status: 200, headers: {} })) as typeof globalThis.fetch;
    const api = new WeixinApi('https://ilinkai.weixin.qq.com/', 'tok');
    await assert.rejects(
      () => api.uploadBufferToCdn(Buffer.from('x'), 'up', 'fk', crypto.randomBytes(16)),
      /missing x-encrypted-param/,
    );
  });

  it('uploadMedia throws when getUploadUrl returns no upload_param', async () => {
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const api = new WeixinApi('https://ilinkai.weixin.qq.com/', 'tok');
    const filePath = join(tempDir, 'a.pdf');
    writeFileSync(filePath, 'abc');
    await assert.rejects(
      () => api.uploadMedia(filePath, 'user-1', UploadMediaType.FILE),
      /no upload_param/,
    );
  });
});
