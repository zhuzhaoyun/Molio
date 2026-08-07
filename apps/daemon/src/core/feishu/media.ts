import fs from 'node:fs';
import path from 'node:path';
import type { FeishuAttachment, ParsedFeishuMessage } from './types.js';
import { imageExt, sanitizeFileName, todayDir } from '../channels/media-helpers.js';

/**
 * Feishu attachment download — no AES decryption (unlike weixin). `downloadFn`
 * is typically `FeishuService.downloadAttachment`, which hits the
 * message-resource endpoint (`im/v1/messages/{message_id}/resources/{key}`)
 * because the plain `im/v1/files|images` endpoints only serve app-uploaded
 * resources (user-sent keys fail there with 234008).
 */
export interface FeishuDownloadFn {
  (att: FeishuAttachment): Promise<{ data: Buffer; contentType: string }>;
}

/**
 * Download every attachment in the message to `cwd/raw/feishu/<date>/` and
 * rewrite `message.text` so each attachment descriptor line points at the
 * local file path instead of the key placeholder. On download failure the
 * placeholder is replaced with a `[文件下载失败: ...]` / `[图片下载失败: ...]`
 * marker so the agent can explain the failure to the user instead of staring
 * at a dead `file_key`. No-op when there are no attachments or no downloadFn;
 * warns (and no-ops) when cwd is missing.
 */
export async function materializeFeishuAttachments(
  message: ParsedFeishuMessage,
  cwd: string | undefined,
  downloadFn: FeishuDownloadFn | undefined,
): Promise<void> {
  if (!message.attachments?.length || !downloadFn) return;
  if (!cwd) {
    // eslint-disable-next-line no-console
    console.warn('[feishu-media] attachments present but no cwd configured — skipping download (check defaultCwd / vault selection)');
    return;
  }

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
    const label = att.kind === 'image' ? '图片' : '文件';
    const placeholder = att.kind === 'image'
      ? `image_key: ${att.key}`
      : `file_key: ${att.key}`;
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

      const localDesc = `[${label}] 已下载到本地：${outPath}`;
      if (message.text.includes(placeholder)) {
        // Function replacement: with a string replacement `$` sequences in the
        // replacement (`$&`, `$'`, `$1`, …) are special patterns — `outPath`
        // can contain them (sanitizeFileName keeps `$`) and would be corrupted.
        message.text = message.text.replace(placeholder, () => outPath);
      }
      if (!message.text.includes(outPath)) {
        message.text = `${message.text}\n${localDesc}`;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.log(`[feishu-download] failed: ${reason} key=${att.key}`);
      // Swap the dead key placeholder for a human-readable failure marker so
      // the agent can relay the reason to the user (and suggest re-login /
      // re-send) instead of pretending the file is available. Prefix must NOT
      // be `[注:` (wiki-fetcher convention) and won't trip buildFeishuPrompt's
      // Case 2, which also requires a feishu.cn/larksuite.com URL in the text.
      const failureDesc = `[${label}下载失败: ${reason}]`;
      if (message.text.includes(placeholder)) {
        // Function replacement: `reason` is external input (Feishu API msg /
        // network error) and a string replacement would interpret `$&`, `$'`,
        // `$1`, … inside it as substitution patterns, corrupting the marker.
        message.text = message.text.replace(placeholder, () => failureDesc);
      } else {
        message.text = message.text ? `${message.text}\n${failureDesc}` : failureDesc;
      }
    }
  }
}
