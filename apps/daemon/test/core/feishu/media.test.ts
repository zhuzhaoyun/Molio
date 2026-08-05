import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeFeishuAttachments } from '../../../src/core/feishu/media.js';
import type { FeishuAttachment, ParsedFeishuMessage } from '../../../src/core/feishu/types.js';

function makeMessage(text: string, attachments: FeishuAttachment[]): ParsedFeishuMessage {
  return {
    id: 'om_test',
    fromUserId: 'ou_sender',
    text,
    attachments,
    raw: {},
  };
}

/**
 * materializeFeishuAttachments tests. The write path was switched from
 * `writeFileSync` to `await fs.promises.writeFile` so a large attachment no
 * longer blocks the event loop (and stalls SSE/HTTP) while flushing to disk —
 * these tests pin the externally observable behavior (bytes land on disk, text
 * is rewritten to local paths) so the async swap can't regress silently.
 */
describe('materializeFeishuAttachments', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'molio-feishu-media-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('downloads attachments, writes bytes to disk, and rewrites text to local paths', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fileBytes = Buffer.from('hello pdf bytes');
    const downloads: Record<string, Buffer> = {
      img_key_1: pngBytes,
      file_key_1: fileBytes,
    };
    const downloadFn = async (att: FeishuAttachment) => ({
      data: downloads[att.key]!,
      contentType: att.kind === 'image' ? 'image/png' : 'application/pdf',
    });

    const message = makeMessage('image_key: img_key_1\nfile_key: file_key_1', [
      { kind: 'image', key: 'img_key_1' }, // no fileName → generated name, png sniffed
      { kind: 'file', key: 'file_key_1', fileName: 'report.pdf' },
    ]);

    await materializeFeishuAttachments(message, cwd, downloadFn);

    // Image: generated name with sniffed .png ext; bytes land on disk.
    const lines = message.text.split('\n');
    const imgPath = lines.find((l) => l.includes('raw') && l.includes('.png'));
    assert.ok(imgPath, `expected a .png local path in rewritten text, got:\n${message.text}`);
    assert.ok(existsSync(imgPath!), 'image bytes should be written to disk');
    assert.deepEqual(readFileSync(imgPath!), pngBytes);

    // File: sanitized provided name; bytes land on disk; placeholder replaced.
    const pdfPath = lines.find((l) => l.endsWith('report.pdf'));
    assert.ok(pdfPath, `expected report.pdf path in rewritten text, got:\n${message.text}`);
    assert.ok(existsSync(pdfPath!), 'file bytes should be written to disk');
    assert.deepEqual(readFileSync(pdfPath!), fileBytes);

    // Placeholders are gone from the dispatched text (the AI sees local paths).
    assert.ok(!message.text.includes('image_key: img_key_1'));
    assert.ok(!message.text.includes('file_key: file_key_1'));
  });

  it('is a no-op when there is no cwd (downloadFn never runs)', async () => {
    const message = makeMessage('image_key: x', [{ kind: 'image', key: 'x' }]);
    let called = false;
    await materializeFeishuAttachments(message, undefined, async () => {
      called = true;
      return { data: Buffer.alloc(1), contentType: 'image/png' };
    });
    assert.equal(called, false, 'downloadFn must not run without a cwd');
    assert.equal(message.text, 'image_key: x');
  });

  it('leaves the placeholder intact when a download fails (graceful fallback)', async () => {
    const message = makeMessage('file_key: bad', [{ kind: 'file', key: 'bad', fileName: 'x.bin' }]);
    await materializeFeishuAttachments(message, cwd, async () => {
      throw new Error('boom');
    });
    assert.ok(message.text.includes('file_key: bad'), 'failed download keeps the original descriptor');
  });
});
