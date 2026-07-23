import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
