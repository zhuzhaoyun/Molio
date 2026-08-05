import { TextDecoder } from 'node:util';

function parseEnvBytes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Soft cap: files ≤ this load fully into CodeMirror. Env-overridable (tests). */
export const MAX_VIEW_SIZE = parseEnvBytes('MOLIO_MAX_VIEW_SIZE', 50 * 1024 * 1024);
/** Hard cap: above this, daemon refuses content even with ?force. Env-overridable. */
export const HARD_CAP = parseEnvBytes('MOLIO_HARD_CAP', 256 * 1024 * 1024);

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
  // A leading UTF-8 BOM is an authoritative signal from the writing tool —
  // trust it outright. (TextDecoder('utf-8') strips it on decode; UTF-16 BOMs
  // are rare in .txt/.md and would fail UTF-8 strict then fall through to
  // lenient gb18030.)
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return 'utf-8';
  }
  // The fixed-size head read can cut a multibyte char in half at the sample
  // boundary (e.g. bytes 65534-65535 of a 3-byte CJK char), which would make
  // strict UTF-8 validation reject a perfectly valid file and mis-detect it as
  // gb18030. Drop the partial tail so validation only sees complete
  // sequences. Fallback encodings still validate on the ORIGINAL sample:
  // trimming could remove a complete final DBCS char and break a validation
  // that would otherwise pass.
  const complete = trimPartialUtf8Tail(sample);
  if (validates(complete, 'utf-8')) return 'utf-8';
  for (const enc of FALLBACK_ENCODINGS) {
    if (validates(sample, enc)) return enc;
  }
  return 'gb18030'; // lenient fallback
}

/**
 * Drop a trailing incomplete UTF-8 sequence from a sample. Walk back at most
 * 3 bytes (the max number of continuation bytes in a 4-byte sequence).
 */
function trimPartialUtf8Tail(buf: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, buf.length); back += 1) {
    const b = buf[buf.length - back];
    if (b === undefined) return buf; // unreachable (back ≤ length) — be safe
    if ((b & 0x80) === 0) return buf; // ASCII byte — clean boundary
    if ((b & 0xc0) !== 0x80) {
      // Lead byte: expected sequence length from the bit pattern.
      const seqLen =
        (b & 0xe0) === 0xc0 ? 2 :
        (b & 0xf0) === 0xe0 ? 3 :
        (b & 0xf8) === 0xf0 ? 4 : 1; // invalid lead — let strict check reject
      return back < seqLen ? buf.subarray(0, buf.length - back) : buf;
    }
  }
  return buf; // only continuation bytes found — let strict check reject
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