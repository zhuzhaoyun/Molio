import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEncoding,
  decodeAll,
  decideReadStrategy,
  MAX_VIEW_SIZE,
  HARD_CAP,
  FileTooLargeError,
} from '../../src/core/encoding.js';

describe('detectEncoding', () => {
  it('utf-8 multibyte → utf-8', () => {
    assert.equal(detectEncoding(Buffer.from('中文', 'utf8')), 'utf-8');
  });
  it('ascii → utf-8', () => {
    assert.equal(detectEncoding(Buffer.from('hello world')), 'utf-8');
  });
  it('utf-8 BOM → utf-8 (TextDecoder strips)', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]);
    assert.equal(detectEncoding(buf), 'utf-8');
  });
  it('GBK bytes (你好 = c4 e3 ba c3) → gb18030', () => {
    assert.equal(detectEncoding(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), 'gb18030');
  });
  it('empty buffer → utf-8', () => {
    assert.equal(detectEncoding(Buffer.alloc(0)), 'utf-8');
  });
  it('garbage bytes → gb18030 lenient (no throw)', () => {
    const enc = detectEncoding(Buffer.from([0xfe, 0xfe, 0xff, 0xff, 0x80, 0x81]));
    assert.ok(['gb18030', 'utf-8'].includes(enc));
  });
  // Regression (2026-08-03): a 116KB UTF-8-BOM 国标文档 displayed as mojibake.
  // The 64KB sample cut landed inside a 3-byte char (的 = e7 9a 84 split as
  // e7 9a | 84), strict UTF-8 validation failed on the truncated sample, and
  // detection fell through to the lenient gb18030 fallback.
  it('utf-8 sample truncated mid-char at 64KB boundary → utf-8', () => {
    const pad = Buffer.alloc(65534, 0x61); // 'a' × 65534
    const splitChar = Buffer.from('的', 'utf8').subarray(0, 2); // e7 9a | 84 cut
    assert.equal(detectEncoding(Buffer.concat([pad, splitChar])), 'utf-8');
  });
  it('utf-8 sample truncated mid-char (2-byte and 4-byte chars)', () => {
    const pad = Buffer.alloc(100, 0x61);
    assert.equal(detectEncoding(Buffer.concat([pad, Buffer.from([0xc2])])), 'utf-8'); // é = c2 a9 cut
    assert.equal(detectEncoding(Buffer.concat([pad, Buffer.from([0xf0, 0x9f, 0x98])])), 'utf-8'); // 😀 cut
  });
  it('utf-8 BOM with truncated tail still → utf-8', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const sample = Buffer.concat([bom, Buffer.alloc(64, 0x61), Buffer.from([0xe7])]);
    assert.equal(detectEncoding(sample), 'utf-8');
  });
  it('complete multibyte char at sample tail is NOT trimmed', () => {
    // 中 = e4 b8 ad fully present at the end — must stay utf-8, and GBK bytes
    // that end on a char boundary must still detect as gb18030 (trim must not
    // eat a complete final DBCS pair and change fallback validation).
    assert.equal(detectEncoding(Buffer.concat([Buffer.alloc(10, 0x61), Buffer.from('中', 'utf8')])), 'utf-8');
    assert.equal(detectEncoding(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), 'gb18030');
  });
});

describe('decodeAll', () => {
  it('decodes GBK bytes to 你好', () => {
    assert.equal(decodeAll(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), 'gb18030'), '你好');
  });
  it('decodes utf-8', () => {
    assert.equal(decodeAll(Buffer.from('中文', 'utf8'), 'utf-8'), '中文');
  });
  it('lenient on invalid bytes (no throw)', () => {
    assert.doesNotThrow(() => decodeAll(Buffer.from([0xfe, 0xff]), 'gb18030'));
  });
});

describe('decideReadStrategy', () => {
  const M = MAX_VIEW_SIZE; // 50MB
  const H = HARD_CAP; // 256MB
  it('≤ MAX_VIEW_SIZE → full', () => {
    assert.equal(decideReadStrategy(M, false), 'full');
    assert.equal(decideReadStrategy(1, false), 'full');
  });
  it('MAX_VIEW_SIZE < size ≤ HARD_CAP, no force → tooLarge', () => {
    assert.equal(decideReadStrategy(M + 1, false), 'tooLarge');
    assert.equal(decideReadStrategy(H, false), 'tooLarge');
  });
  it('MAX_VIEW_SIZE < size ≤ HARD_CAP, force → full', () => {
    assert.equal(decideReadStrategy(M + 1, true), 'full');
    assert.equal(decideReadStrategy(H, true), 'full');
  });
  it('> HARD_CAP → refuse (even with force)', () => {
    assert.equal(decideReadStrategy(H + 1, false), 'refuse');
    assert.equal(decideReadStrategy(H + 1, true), 'refuse');
  });
});

describe('FileTooLargeError', () => {
  it('is an Error with code', () => {
    const e = new FileTooLargeError(999);
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'EFBIG');
  });
});