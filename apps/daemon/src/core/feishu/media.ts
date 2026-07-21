import fs from 'node:fs';
import path from 'node:path';
import type { FeishuAttachment, ParsedFeishuMessage } from './types.js';
import { imageExt, sanitizeFileName, todayDir } from '../channels/media-helpers.js';

/**
 * Feishu downloads by `image_key` / `file_key` via the authenticated
 * `im/v1/images` / `im/v1/files` endpoints — no AES decryption (unlike weixin).
 * `downloadFn` is typically `FeishuApi.downloadImage` / `downloadFile`.
 */
export interface FeishuDownloadFn {
  (att: FeishuAttachment): Promise<{ data: Buffer; contentType: string }>;
}

/**
 * Download every attachment in the message to `cwd/raw/feishu/<date>/` and
 * rewrite `message.text` so each attachment descriptor line points at the
 * local file path instead of the key placeholder. Falls back gracefully
 * (leaves the original descriptor) if a download fails. No-op when there are
 * no attachments, no cwd, or no downloadFn.
 */
export async function materializeFeishuAttachments(
  message: ParsedFeishuMessage,
  cwd: string | undefined,
  downloadFn: FeishuDownloadFn | undefined,
): Promise<void> {
  if (!message.attachments?.length || !cwd || !downloadFn) return;

  const dir = path.join(cwd, 'raw', 'feishu', todayDir());
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // Log + return — without the inbox dir we can't save any attachment, but
    // we shouldn't proceed silently either (the caller would then dispatch
    // with placeholder keys the AI can't read). Surface via console so the
    // user sees why their attachments didn't materialize.
    // eslint-disable-next-line no-console
    console.error(
      `[feishu-media] mkdir failed (${err instanceof Error ? err.message : String(err)}): ${dir}`,
    );
    return;
  }

  const stamp = String(Date.now());
  let index = 0;
  for (const att of message.attachments) {
    index += 1;
    try {
      const { data, contentType } = await downloadFn(att);
      const ext = att.kind === 'image'
        ? imageExt(contentType, data)
        : path.extname(att.fileName ?? '') || 'bin';
      const baseName = att.fileName
        ? sanitizeFileName(att.fileName)
        : `${stamp}-${index}.${ext}`;
      const outPath = path.join(dir, baseName);
      // Async write — writeFileSync would block the event loop for each
      // attachment, stalling SSE/HTTP while a large file flushes to disk.
      await fs.promises.writeFile(outPath, data);

      const label = att.kind === 'image' ? '图片' : '文件';
      const placeholder = att.kind === 'image'
        ? `image_key: ${att.key}`
        : `file_key: ${att.key}`;
      const localDesc = `[${label}] 已下载到本地：${outPath}`;
      if (message.text.includes(placeholder)) {
        message.text = message.text.replace(placeholder, outPath);
      }
      if (!message.text.includes(outPath)) {
        message.text = `${message.text}\n${localDesc}`;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[feishu-download] failed: ${err instanceof Error ? err.message : String(err)} key=${att.key}`);
    }
  }
}
