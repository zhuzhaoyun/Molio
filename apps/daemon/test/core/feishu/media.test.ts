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
      { kind: 'image', key: 'img_key_1', messageId: 'om_test' }, // no fileName → generated name, png sniffed
      { kind: 'file', key: 'file_key_1', messageId: 'om_test', fileName: 'report.pdf' },
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
    const message = makeMessage('image_key: x', [{ kind: 'image', key: 'x', messageId: 'om_test' }]);
    let called = false;
    await materializeFeishuAttachments(message, undefined, async () => {
      called = true;
      return { data: Buffer.alloc(1), contentType: 'image/png' };
    });
    assert.equal(called, false, 'downloadFn must not run without a cwd');
    assert.equal(message.text, 'image_key: x');
  });

  /**
   * 234008 regression: before the fix a failed download left the dead
   * `file_key: ...` placeholder in the dispatched text, so the agent had no
   * way to tell the user what happened. The placeholder must now be replaced
   * by a `[文件下载失败: ...]` / `[图片下载失败: ...]` marker carrying the
   * reason, and the raw key placeholder must not survive.
   */
  it('replaces the placeholder with a failure marker when a download fails', async () => {
    const message = makeMessage('file_key: bad', [{ kind: 'file', key: 'bad', messageId: 'om_test', fileName: 'x.bin' }]);
    await materializeFeishuAttachments(message, cwd, async () => {
      throw new Error('Feishu message resource download 400: The app is not the resource sender');
    });
    assert.ok(
      message.text.includes('[文件下载失败:'),
      `expected a 文件下载失败 marker, got:\n${message.text}`,
    );
    assert.ok(
      message.text.includes('The app is not the resource sender'),
      'failure marker should carry the underlying reason',
    );
    assert.ok(!message.text.includes('file_key: bad'), 'dead key placeholder must not survive');
  });

  it('replaces the placeholder with a 图片下载失败 marker for image failures', async () => {
    const message = makeMessage('[图片] image_key: img_bad', [{ kind: 'image', key: 'img_bad', messageId: 'om_test' }]);
    await materializeFeishuAttachments(message, cwd, async () => {
      throw new Error('boom');
    });
    assert.ok(message.text.includes('[图片下载失败: boom]'));
    assert.ok(!message.text.includes('image_key: img_bad'));
  });

  /**
   * `String.prototype.replace(str, str)` treats `$&`, `$'`, `` $` ``, `$1`…
   * in the REPLACEMENT as substitution patterns. The failure reason is
   * external input (Feishu API msg / network error), so it must be inserted
   * literally — a function replacement — or a reason containing `$` sequences
   * would silently corrupt the marker.
   */
  it('keeps $ sequences in the failure reason literal (no replace-pattern expansion)', async () => {
    const message = makeMessage('file_key: bad', [{ kind: 'file', key: 'bad', messageId: 'om_test' }]);
    await materializeFeishuAttachments(message, cwd, async () => {
      throw new Error("gateway said $& then $' and $1");
    });
    assert.ok(
      message.text.includes("[文件下载失败: gateway said $& then $' and $1]"),
      `failure marker must carry the reason verbatim, got:\n${message.text}`,
    );
    assert.ok(!message.text.includes('file_key: bad'), 'dead key placeholder must not survive');
  });

  /**
   * Same `$`-pattern hazard on the SUCCESS path: `sanitizeFileName` keeps `$`,
   * so a user-sent file named e.g. `price$&list.md` yields an `outPath` with
   * `$&` in it. A string replacement would expand `$&` back to the matched
   * placeholder, resurrecting the dead key inside the rewritten text.
   */
  it('keeps $ sequences in the downloaded file path literal (no replace-pattern expansion)', async () => {
    const message = makeMessage('file_key: k1', [{ kind: 'file', key: 'k1', messageId: 'om_test', fileName: 'a$&b.md' }]);
    await materializeFeishuAttachments(message, cwd, async () => ({
      data: Buffer.from('dollar bytes'),
      contentType: 'text/markdown',
    }));
    const pathLine = message.text.split('\n').find((l) => l.endsWith('a$&b.md'));
    assert.ok(pathLine, `expected the literal $& path in rewritten text, got:\n${message.text}`);
    assert.ok(existsSync(pathLine!), 'file with $& in its name should land on disk');
    assert.deepEqual(readFileSync(pathLine!), Buffer.from('dollar bytes'));
    // Before the fix `$&` expanded to the matched placeholder itself, so the
    // dead key survived inside the corrupted path.
    assert.ok(!message.text.includes('file_key: k1'), 'placeholder must not be resurrected by $& expansion');
  });
});
