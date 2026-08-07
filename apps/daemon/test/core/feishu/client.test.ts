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

/**
 * downloadMessageResource — the user-sent attachment download path.
 *
 * Regression: user-sent files were downloaded via `im/v1/files/{file_key}`,
 * which only serves app-uploaded resources; Feishu answered with 400
 * "The app is not the resource sender" (code 234008). The fix routes inbound
 * attachments through `im/v1/messages/{message_id}/resources/{file_key}?type=…`.
 */
describe('FeishuApi.downloadMessageResource', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('GETs messages/{messageId}/resources/{fileKey}?type=… with the Bearer token', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const bytes = Buffer.from([1, 2, 3, 4]);
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }) as typeof fetch;

    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const { data, contentType } = await api.downloadMessageResource(
      'tok_abc', 'om_msg_1', 'file_v3_001', 'file',
    );
    assert.equal(
      seenUrl,
      'https://open.feishu.cn/open-apis/im/v1/messages/om_msg_1/resources/file_v3_001?type=file',
    );
    assert.equal(seenAuth, 'Bearer tok_abc');
    assert.deepEqual(data, bytes);
    assert.equal(contentType, 'application/octet-stream');
  });

  it('passes type=image through the query string', async () => {
    let seenUrl = '';
    globalThis.fetch = (async (url: URL | string) => {
      seenUrl = String(url);
      return new Response(Buffer.from([9]), { status: 200 });
    }) as typeof fetch;

    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    await api.downloadMessageResource('tok', 'om_msg_2', 'img_v3_9', 'image');
    assert.ok(seenUrl.endsWith('/resources/img_v3_9?type=image'), seenUrl);
  });

  it('throws with the Feishu msg on 400 (234008 repro: "The app is not the resource sender")', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ code: 400, msg: 'The app is not the resource sender' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    await assert.rejects(
      () => api.downloadMessageResource('tok', 'om_msg_1', 'file_v3_001', 'file'),
      /message resource download 400: The app is not the resource sender/,
    );
  });

  it('throws BEFORE any network call when messageId is empty', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('x', { status: 200 });
    }) as typeof fetch;

    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    await assert.rejects(
      () => api.downloadMessageResource('tok', '', 'file_v3_001', 'file'),
      /messageId is required/,
    );
    assert.equal(called, false, 'no request may go out without a messageId');
  });

  /**
   * Download timeout semantics. The old implementation armed ONE timer for
   * the whole request (headers + body), so a large file on a slow uplink
   * (64MB cap ÷ <~1MB/s) was aborted mid-body and surfaced to the user as
   * "下载失败" although the transfer was merely slow. The timeout is now an
   * INACTIVITY timeout: it bounds the header phase and resets on every chunk
   * that arrives, aborting only connections that go silent.
   */

  /**
   * Stream `chunks` with a `delayMs` network latency before each chunk.
   * `init.signal` is wired to the stream the way real (undici) fetch does it:
   * aborting the signal errors the body stream, so a pending `reader.read()`
   * rejects with the AbortError — without this wiring a mock stream would
   * happily keep delivering chunks after the abort fired.
   */
  function slowStreamResponse(chunks: Array<{ data: Buffer; delayMs: number }>, init?: RequestInit): Response {
    const signal = init?.signal;
    let i = 0;
    let underlying: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        underlying = controller;
      },
      async pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[i]!;
        i += 1;
        await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
        if (signal?.aborted) return; // already errored via the abort listener
        controller.enqueue(chunk.data);
      },
    });
    signal?.addEventListener('abort', () => {
      underlying?.error(signal.reason ?? new Error('aborted'));
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  it('survives a slow-but-steady stream whose TOTAL time exceeds the timeout (inactivity reset per chunk)', async () => {
    // 4 chunks × 120ms latency = ~480ms total, well over the 300ms timeout —
    // but each individual gap (120ms) stays under it, so the download must
    // complete. Under the old total-timeout implementation this aborted
    // mid-body at ~300ms.
    globalThis.fetch = (async (_url: URL | string, init?: RequestInit) => slowStreamResponse([
      { data: Buffer.from('aaaa'), delayMs: 120 },
      { data: Buffer.from('bbbb'), delayMs: 120 },
      { data: Buffer.from('cccc'), delayMs: 120 },
      { data: Buffer.from('dddd'), delayMs: 120 },
    ], init)) as typeof fetch;

    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const started = Date.now();
    const { data } = await api.downloadMessageResource('tok', 'om_msg_1', 'file_v3_001', 'file', 300);
    assert.equal(data.toString(), 'aaaabbbbccccdddd');
    assert.ok(Date.now() - started > 400, 'stream actually took longer than the timeout — proof the timer reset');
  });

  it('aborts a STALLED stream once no chunk arrives within the timeout', async () => {
    // First chunk arrives quickly, then the connection goes silent for 600ms —
    // far beyond the 150ms inactivity window, so the download must abort.
    globalThis.fetch = (async (_url: URL | string, init?: RequestInit) => slowStreamResponse([
      { data: Buffer.from('head'), delayMs: 30 },
      { data: Buffer.from('never'), delayMs: 600 },
    ], init)) as typeof fetch;

    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const started = Date.now();
    await assert.rejects(
      () => api.downloadMessageResource('tok', 'om_msg_1', 'file_v3_001', 'file', 150),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
    assert.ok(Date.now() - started < 500, 'abort must fire at the inactivity window, not when the stream finally delivers');
  });

  it('still bounds the HEADER phase: no response at all within the timeout aborts', async () => {
    // A mock fetch that honors the signal: resolves only after 500ms, rejects
    // as soon as the abort signal fires. With a 100ms timeout the request must
    // abort during the header wait, long before the mock would resolve.
    globalThis.fetch = ((_url: URL | string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const late = setTimeout(() => resolve(new Response(Buffer.from('too late'), { status: 200 })), 500);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(late);
        reject(init?.signal?.reason ?? new Error('aborted'));
      });
    })) as typeof fetch;

    const api = new FeishuApi('https://open.feishu.cn', 'cli_x', 'sec_x');
    const started = Date.now();
    await assert.rejects(
      () => api.downloadMessageResource('tok', 'om_msg_1', 'file_v3_001', 'file', 100),
      (err: unknown) => (err as Error).name === 'AbortError',
    );
    assert.ok(Date.now() - started < 400, 'header-phase abort must fire near the timeout, not at 500ms');
  });
});
