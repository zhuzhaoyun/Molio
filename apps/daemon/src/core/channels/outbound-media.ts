import fs from 'node:fs';
import path from 'node:path';
import type { OutboundMediaItem } from './types.js';

/**
 * Cross-channel outbound media parsing.
 *
 * Extracted from `weixin/outbound-media.ts` because the `<attach path="..."/>`
 * marker convention and file-kind classification are channel-agnostic — feishu,
 * wecom, and weixin all share the same protocol: AI emits a marker, daemon
 * resolves the local file and delivers it via the channel sink, then strips the
 * marker from the user-facing text so no local path ever reaches the IM.
 */

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

/**
 * Why an `<attach/>` marker could not be turned into a deliverable file.
 * Surfaced to the dispatcher so it can tell the USER the attachment was NOT
 * delivered (2026-08-23 incident: the AI said "已附上", the marker's path
 * didn't resolve, the marker was stripped silently, and the user waited for a
 * file that never arrived — with nothing in the logs to explain it).
 */
export type OutboundMediaFailReason =
  | 'blocked-traversal' // `..` segment — rejected before resolution (exfiltration guard)
  | 'not-found' // no file at the resolved path
  | 'not-a-file' // path exists but is a directory (or other non-file)
  | 'unsupported-type'; // extension not deliverable over IM channels

/** An `<attach/>` marker whose file could not be delivered. */
export interface OutboundMediaFailure {
  /** The raw path exactly as the AI wrote it inside the marker. */
  path: string;
  reason: OutboundMediaFailReason;
}

type ResolveResult =
  | { kind: 'item'; item: OutboundMediaItem }
  | { kind: 'failure'; failure: OutboundMediaFailure }
  // Duplicate of a file already deliverable this turn — silently skipped
  // (a repeated marker is not an error worth bothering the user about).
  | { kind: 'duplicate' };

/**
 * Resolve a candidate path against `cwd`; if it points to an existing
 * deliverable file, return an outbound item; otherwise a typed failure the
 * caller must surface (never silently — the user-facing text already claims
 * the file was attached). `seen` dedupes by resolved absolute path.
 */
function resolveDeliverable(
  candidate: string,
  cwd: string | undefined,
  seen: Set<string>,
): ResolveResult {
  // Reject path traversal: an AI prompted via inbound IM message could be
  // tricked into emitting `<attach path="../../.ssh/id_rsa"/>` to exfiltrate
  // files outside the project. Block any `..` segment in the candidate before
  // resolution. Absolute paths (e.g. to a temp dir the AI wrote to) are still
  // honored — the AI explicitly chose them.
  const candidateSegments = candidate.split(/[\\/]/);
  if (candidateSegments.includes('..')) {
    return { kind: 'failure', failure: { path: candidate, reason: 'blocked-traversal' } };
  }

  const base = path.resolve(cwd ?? process.cwd());
  const abs = path.resolve(base, candidate);
  if (seen.has(abs)) return { kind: 'duplicate' };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { kind: 'failure', failure: { path: candidate, reason: 'not-found' } };
  }
  if (!stat.isFile()) return { kind: 'failure', failure: { path: candidate, reason: 'not-a-file' } };
  const kind = classifyByExt(extOf(abs));
  if (!kind) {
    return { kind: 'failure', failure: { path: candidate, reason: 'unsupported-type' } };
  }
  seen.add(abs);
  return { kind: 'item', item: { filePath: abs, fileName: path.basename(abs), kind } };
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
 * Attachment marker the AI emits in its reply to request a file be delivered.
 * Molio parses these, uploads each file as an attachment, and strips the
 * markers from the text before sending it to the IM channel — so the user
 * never sees a local path, only the file attachment + a clean message.
 *
 * Format: `<attach path="..."/>` (single or double quotes). The regex is
 * deliberately tolerant of the variants models actually produce:
 *   `<attach path="x"/>` / `<attach path="x">`      — self-closed or open
 *   `<attach path="x"></attach>`                    — explicit closing tag
 *   `<attach name="y" path="x"/>`                   — extra / reordered attrs
 * A marker missed here leaks into the IM card and is rendered as an invisible
 * HTML tag — the user sees "已附上" text but no file, with no log to explain
 * it. When in doubt, match more.
 */
const ATTACH_MARKER_RE =
  /<attach\b[^<>]*?\bpath\s*=\s*["']([^"']+)["'][^<>]*?\/?>(?:\s*<\/attach\s*>)?/g;

/**
 * Extract deliverable files for the turn from `<attach path="..."/>` markers
 * in the reply text.
 *
 * Delivery is EXPLICIT ONLY: a file is sent to the IM channel solely when the
 * AI writes an `<attach/>` marker for it (the wiki prompt instructs it to do
 * precisely when the user asks for a file). Files the AI creates via Write or
 * Edit during a turn are NOT auto-delivered — in a knowledge-base workflow
 * Write is routinely used for internal work (wiki pages, staging files,
 * notes), so auto-delivering on Write would spam the user with every .md
 * produced during ingestion. Markers are stripped from the returned `text` so
 * the channel-bound reply never contains local paths; the user receives the
 * file as an attachment plus a clean text message. Files are deduped by
 * resolved absolute path.
 *
 * Markers whose path does NOT resolve are reported in `failed` (and still
 * stripped from `text`): the reply text usually claims the file was attached,
 * so the dispatcher must surface a visible "could not deliver" notice instead
 * of leaving the user waiting for a file that will never arrive.
 */
export function extractOutboundMedia(
  replyText: string,
  cwd: string | undefined,
): { items: OutboundMediaItem[]; text: string; failed: OutboundMediaFailure[] } {
  const seen = new Set<string>();
  const items: OutboundMediaItem[] = [];
  const failed: OutboundMediaFailure[] = [];

  // Parse + strip <attach path="..."/> markers. The path is only used to
  // locate the file locally; it never reaches the IM channel as text.
  const text = replyText.replace(ATTACH_MARKER_RE, (_m, rawPath: string) => {
    const result = resolveDeliverable(rawPath, cwd, seen);
    if (result.kind === 'item') items.push(result.item);
    else if (result.kind === 'failure') failed.push(result.failure);
    return '';
  });

  return { items, text: tidyText(text), failed };
}
