'use strict';
/**
 * Encoding detection + decode — zero dependencies.
 *
 * Strategy (first match wins):
 *   1. --charset override from the caller
 *   2. BOM sniff (UTF-8 / UTF-16LE / UTF-16BE)
 *   3. Strict UTF-8 validation (fatal decoder)
 *   4. Heuristic scoring of legacy CJK encodings (gb18030 / big5 / shift-jis /
 *      euc-kr): decode a head+tail sample, score by CJK ideograph ratio, pick
 *      the winner if the score clears a threshold. gb18030 accepts almost any
 *      byte sequence, so "does it decode" is not a signal — the ratio of real
 *      CJK characters in the decoded sample is.
 *   5. Lossy UTF-8 fallback (with a warning hint)
 *
 * Only the sample is decoded for scoring; the full buffer is decoded exactly
 * once with the winning encoding.
 */

const SAMPLE_BYTES = 512 * 1024;
/** Minimum CJK ratio for a legacy-encoding decode to be trusted. */
const SCORE_THRESHOLD = 0.3;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** CJK ideograph ratio over the decoded sample (skips control chars). */
function cjkScore(text) {
  let cjk = 0;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xffff) i++; // surrogate pair — counted once
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    total++;
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
  }
  return total ? cjk / total : 0;
}

/** Head+tail sample buffer — cheap to decode, representative for scoring. */
function sampleBuffer(buffer) {
  if (buffer.length <= SAMPLE_BYTES * 2) return buffer;
  return Buffer.concat([
    buffer.subarray(0, SAMPLE_BYTES),
    buffer.subarray(buffer.length - SAMPLE_BYTES),
  ]);
}

function tryDecoder(encoding) {
  try {
    return new TextDecoder(encoding);
  } catch {
    return null; // this Node/ICU build lacks the codec
  }
}

/**
 * Detect the encoding of `buffer` and decode it.
 *
 * @param {Buffer} buffer raw file bytes
 * @param {string} [charsetOverride] force this encoding (skip detection)
 * @returns {{ text: string, encoding: string, hint?: string }}
 * @throws if charsetOverride names an unknown codec
 */
function detectAndDecode(buffer, charsetOverride) {
  if (charsetOverride) {
    const dec = tryDecoder(charsetOverride);
    if (!dec) throw new Error(`unknown charset: ${charsetOverride}`);
    return { text: stripBom(dec.decode(buffer)), encoding: charsetOverride };
  }

  // ── BOM sniff ──
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.toString('utf8').replace(/^﻿/, ''), encoding: 'utf-8-bom' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: stripBom(new TextDecoder('utf-16le').decode(buffer.subarray(2))), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: stripBom(new TextDecoder('utf-16be').decode(buffer.subarray(2))), encoding: 'utf-16be' };
  }

  // ── Strict UTF-8 ──
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    // Not valid UTF-8 — fall through to legacy scoring.
  }

  // ── Legacy CJK scoring ──
  const sample = sampleBuffer(buffer);
  const scored = [];
  for (const enc of ['gb18030', 'big5', 'shift-jis', 'euc-kr']) {
    const dec = tryDecoder(enc);
    if (!dec) continue;
    scored.push({ enc, score: cjkScore(dec.decode(sample)) });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length && scored[0].score > SCORE_THRESHOLD) {
    const winner = scored[0];
    const dec = tryDecoder(winner.enc);
    return {
      text: stripBom(dec.decode(buffer)),
      encoding: winner.enc,
      hint: `编码启发式判定为 ${winner.enc}（CJK 占比 ${(winner.score * 100).toFixed(0)}%；可用 --charset 覆盖）`,
    };
  }

  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(buffer),
    encoding: 'utf-8-lossy',
    hint: '无法可靠判定编码，已按 UTF-8 有损解码（乱码风险；可用 --charset 指定）',
  };
}

export { detectAndDecode, cjkScore };
