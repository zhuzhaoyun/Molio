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