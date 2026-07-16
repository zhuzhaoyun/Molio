/**
 * Cross-channel media helpers used by `materializeAttachments` in each
 * channel's media module. Pure functions of (bytes / strings / dates) — no
 * protocol-specific code — so weixin/feishu/wecom can share them without
 * coupling.
 */

/** Today's date as YYYY-MM-DD, for the raw/<channel>/<date>/ layout. */
export function todayDir(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Pick a file extension for an image based on downloaded bytes/content-type. */
export function imageExt(contentType: string, data: Buffer): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('bmp')) return 'bmp';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  return 'jpg';
}

/** Sanitize a filename to something safe for the local filesystem. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\/:*?"<>| -]/g, '_').trim();
  return cleaned || 'attachment';
}
