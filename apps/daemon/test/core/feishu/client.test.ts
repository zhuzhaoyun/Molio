import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMarkdownCard } from '../../../src/core/feishu/card.js';
import { FeishuApi } from '../../../src/core/feishu/client.js';

/**
 * Upload size-guard tests. `resolveDeliverable` deliberately honors absolute
 * paths in the AI's `<attach/>` marker, so without a guard `uploadImage`/
 * `uploadFile` would `readFile` a multi-GB file fully into memory and OOM the
 * daemon before Feishu's own ~100MB limit rejects it. The guard must refuse
 * oversized files BEFORE any network request is made.
 */
describe('FeishuApi upload size guard', () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-feishu-upload-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Mock the im/v1/images + im/v1/files endpoints; count every network hit. */
  function mockUploadEndpoint(): { callCount: number } {
    const counter = { callCount: 0 };
    globalThis.fetch = (async (url: URL | string) => {
      counter.callCount += 1;
      const target = String(url);
      if (target.includes('/im/v1/images')) {
        return new Response(JSON.stringify({ code: 0, data: { image_key: 'img_x' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('/im/v1/files')) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: 'file_x' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return counter;
  }

  it('uploadImage rejects a file larger than maxBytes BEFORE any network call', async () => {
    const counter = mockUploadEndpoint();
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const bigFile = join(tempDir, 'big.png');
    writeFileSync(bigFile, Buffer.alloc(1024, 1));

    await assert.rejects(
      () => api.uploadImage('tok', bigFile, 100), // cap 100 < 1024 bytes
      /too large/,
    );
    assert.equal(counter.callCount, 0, 'size guard must fire before the upload request');
  });

  it('uploadFile rejects a file larger than maxBytes BEFORE any network call', async () => {
    const counter = mockUploadEndpoint();
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const bigFile = join(tempDir, 'big.pdf');
    writeFileSync(bigFile, Buffer.alloc(2048, 2));

    await assert.rejects(
      () => api.uploadFile('tok', bigFile, 512), // cap 512 < 2048 bytes
      /too large/,
    );
    assert.equal(counter.callCount, 0, 'size guard must fire before the upload request');
  });

  it('uploadImage allows a file within maxBytes and returns image_key', async () => {
    const counter = mockUploadEndpoint();
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const smallFile = join(tempDir, 'small.png');
    writeFileSync(smallFile, Buffer.alloc(50, 3));

    const imageKey = await api.uploadImage('tok', smallFile, 100); // 50 < 100
    assert.equal(imageKey, 'img_x');
    assert.equal(counter.callCount, 1);
  });

  it('uploadFile allows a file within maxBytes and returns file_key', async () => {
    const counter = mockUploadEndpoint();
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const smallFile = join(tempDir, 'small.pdf');
    writeFileSync(smallFile, Buffer.alloc(50, 4));

    const fileKey = await api.uploadFile('tok', smallFile, 100); // 50 < 100
    assert.equal(fileKey, 'file_x');
    assert.equal(counter.callCount, 1);
  });
});

describe('FeishuApi message sending (postMessage)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Mock im/v1/messages and capture every request body for assertions. */
  function mockMessagesEndpoint(
    response: Record<string, unknown> = { code: 0, data: { message_id: 'om_msg_x' } },
  ): { bodies: Array<Record<string, unknown>> } {
    const captured = { bodies: [] as Array<Record<string, unknown>> };
    globalThis.fetch = (async (_url: URL | string, init?: RequestInit) => {
      captured.bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return captured;
  }

  it('sendText posts msg_type=text and returns message_id (refactor regression)', async () => {
    const captured = mockMessagesEndpoint();
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const msgId = await api.sendText('tok', 'ou_user', 'hello');
    assert.equal(msgId, 'om_msg_x');
    assert.equal(captured.bodies.length, 1);
    const body = captured.bodies[0]!;
    assert.equal(body.receive_id, 'ou_user');
    assert.equal(body.msg_type, 'text');
    assert.deepEqual(JSON.parse(String(body.content)), { text: 'hello' });
  });

  it('sendCard posts msg_type=interactive with the card JSON-stringified into content', async () => {
    const captured = mockMessagesEndpoint();
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const msgId = await api.sendCard('tok', 'ou_user', buildMarkdownCard('# T\n**bold**'));
    assert.equal(msgId, 'om_msg_x');
    assert.equal(captured.bodies.length, 1);
    const body = captured.bodies[0]!;
    assert.equal(body.receive_id, 'ou_user');
    assert.equal(body.msg_type, 'interactive');
    assert.deepEqual(JSON.parse(String(body.content)), {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: '# T\n**bold**' }] },
    });
  });

  it('sendCard sends the Authorization header with the tenant token', async () => {
    let authHeader = '';
    globalThis.fetch = (async (_url: URL | string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authHeader = headers.Authorization ?? '';
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    await api.sendCard('tok_abc', 'ou_user', buildMarkdownCard('x'));
    assert.equal(authHeader, 'Bearer tok_abc');
  });

  it('sendCard throws a typed error carrying Feishu msg on non-zero code', async () => {
    mockMessagesEndpoint({ code: 300300, msg: 'card size exceeds 30KB' });
    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    await assert.rejects(
      () => api.sendCard('tok', 'ou_user', buildMarkdownCard('x')),
      /sendCard failed: card size exceeds 30KB/,
    );
  });
});
