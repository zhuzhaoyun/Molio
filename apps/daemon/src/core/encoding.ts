import { TextDecoder } from 'node:util';

/** Soft cap: files ≤ this load fully into CodeMirror. Env-overridable (tests). */
export const MAX_VIEW_SIZE = Number(process.env.MOLIO_MAX_VIEW_SIZE) || 50 * 1024 * 1024;
/** Hard cap: above this, daemon refuses content even with ?force. Env-overridable. */
export const HARD_CAP = Number(process.env.MOLIO_HARD_CAP) || 256 * 1024 * 1024;

/** Encodings tried, in order, after UTF-8 fails. gb18030 is a GBK superset. */
const FALLBACK_ENCODINGS = ['gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr'];

/**
 * Detect text encoding from a sample (first 64KB is enough). UTF-8 is checked
 * first (strict) so true UTF-8 files are never mis-decoded; otherwise we try
 * common Asian DBCS encodings. Line separator 0x0A is never a trail byte in
 * any of these, so line-based chunking (Phase 3) will be safe too.
 */
export function detectEncoding(sample: Buffer): string {
  if (sample.length === 0) return 'utf-8';
  // BOM (TextDecoder('utf-8') strips a leading UTF-8 BOM automatically; UTF-16
  // BOMs are handled by their own decoders, but we don't special-case them
  // here — they are rare in .txt novels and would fail UTF-8 strict then
  // fall through to lenient gb18030.)
  if (validates(sample, 'utf-8')) return 'utf-8';
  for (const enc of FALLBACK_ENCODINGS) {
    if (validates(sample, enc)) return enc;
  }
  return 'gb18030'; // lenient fallback
}

function validates(buf: Buffer, enc: string): boolean {
  try {
    new TextDecoder(enc, { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Decode a full buffer with the given encoding (lenient — never throws). */
export function decodeAll(buf: Buffer, enc: string): string {
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

export type ReadStrategy = 'full' | 'tooLarge' | 'refuse';

/** Pure tier decision — unit-testable without fs. */
export function decideReadStrategy(size: number, force: boolean): ReadStrategy {
  if (size <= MAX_VIEW_SIZE) return 'full';
  if (size > HARD_CAP) return 'refuse';
  return force ? 'full' : 'tooLarge';
}

/** Sample size for encoding detection (BOM + enough CJK bytes). */
export const ENCODING_SAMPLE_BYTES = 64 * 1024;

export class FileTooLargeError extends Error {
  code = 'EFBIG' as const;
  constructor(size: number) {
    super(`File too large to view (${size} bytes); open externally`);
    this.name = 'FileTooLargeError';
  }
}