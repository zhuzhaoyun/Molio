import fs from 'node:fs';
import path from 'node:path';
import type { OutboundMediaItem } from './types.js';

/**
 * Tools that create or fully overwrite a file (vs. targeted edits to existing
 * source). Files produced by these are candidate deliverables.
 */
const WRITE_TOOLS = new Set([
  'Write',
  'create_file',
  'write_file',
  'str_replace_editor',
]);

/** Image extensions → delivered as image messages. Lowercase, no dot. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
/** Video extensions → delivered as video messages. */
const VIDEO_EXT = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']);
/** Document/archive/audio extensions → delivered as file attachments. */
const FILE_EXT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'md', 'markdown', 'csv', 'rtf', 'odt', 'ods', 'odp',
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
  'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac',
]);

/** Classify a file extension into a delivery kind, or null if not deliverable. */
export function classifyByExt(ext: string): 'image' | 'file' | 'video' | null {
  const e = ext.toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (FILE_EXT.has(e)) return 'file';
  return null;
}

function extOf(filePath: string): string {
  return path.extname(filePath).slice(1);
}

/** Extract the file path from a tool_use input across common field names. */
function filePathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const candidate = obj.file_path ?? obj.filePath ?? obj.path ?? obj.notebook_path;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

/**
 * Attachment marker the AI emits in its reply to request a file be delivered.
 * Molio parses these, uploads each file as an attachment, and strips the
 * markers from the text before sending it to WeChat — so the user never sees
 * a local path, only the file attachment + a clean message.
 *
 * Format: `<attach path="..."/>` (single or double quotes).
 */
const ATTACH_MARKER_RE = /<attach\s+path\s*=\s*["']([^"']+)["']\s*\/?>/g;

/**
 * Resolve a candidate path against `cwd`; if it points to an existing
 * deliverable file, return an outbound item; otherwise null. `seen` is used
 * to dedupe by resolved absolute path.
 */
function resolveDeliverable(
  candidate: string,
  cwd: string | undefined,
  seen: Set<string>,
): OutboundMediaItem | null {
  const abs = path.resolve(cwd ?? process.cwd(), candidate);
  if (seen.has(abs)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const kind = classifyByExt(extOf(abs));
  if (!kind) return null;
  seen.add(abs);
  return { filePath: abs, fileName: path.basename(abs), kind };
}

/** Tidy up text after marker stripping: drop empty bullets/label lines. */
function tidyText(text: string): string {
  return text
    .replace(/^[ \t]*[-*][ \t]*$/gm, '') // empty bullet lines
    .replace(/^[ \t]*[：:][ \t]*$/gm, '') // dangling label colons
    .replace(/\n{3,}/g, '\n\n') // collapse extra blank lines
    .trim();
}

/**
 * Extract deliverable files for the turn from two signals:
 *   1. `tool_use` events where a Write-like tool wrote a file, and
 *   2. `<attach path="..."/>` markers in the reply text.
 *
 * Markers are stripped from the returned `text` so the WeChat-bound reply
 * never contains local paths — the user receives the file as an attachment
 * plus a clean text message. Files are deduped by resolved absolute path.
 */
export function extractOutboundMedia(
  toolUses: Array<{ name: string; input: unknown }>,
  replyText: string,
  cwd: string | undefined,
): { items: OutboundMediaItem[]; text: string } {
  const seen = new Set<string>();
  const items: OutboundMediaItem[] = [];

  for (const t of toolUses) {
    if (!WRITE_TOOLS.has(t.name)) continue;
    const relOrAbs = filePathFromInput(t.input);
    if (!relOrAbs) continue;
    const item = resolveDeliverable(relOrAbs, cwd, seen);
    if (item) items.push(item);
  }

  // Parse + strip <attach path="..."/> markers. The path is only used to
  // locate the file locally; it never reaches WeChat as text.
  const text = replyText.replace(ATTACH_MARKER_RE, (_m, rawPath: string) => {
    const item = resolveDeliverable(rawPath, cwd, seen);
    if (item) items.push(item);
    return '';
  });

  return { items, text: tidyText(text) };
}
