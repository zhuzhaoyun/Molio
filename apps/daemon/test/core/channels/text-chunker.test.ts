import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../../../src/core/channels/text-chunker.js';

describe('chunkText', () => {
  it('returns the input as a single chunk when within limit', () => {
    assert.deepEqual(chunkText('hello', 100), ['hello']);
  });

  it('returns a single chunk when length equals the limit exactly', () => {
    const text = 'a'.repeat(10);
    assert.deepEqual(chunkText(text, 10), [text]);
  });

  it('cuts at a paragraph break (\\n\\n) within the limit', () => {
    const text = 'first paragraph\n\nsecond paragraph';
    // limit 18 — the '\n\n' starts at index 16, so cut at 16 produces 'first paragraph'.
    const chunks = chunkText(text, 18);
    assert.deepEqual(chunks, ['first paragraph', 'second paragraph']);
  });

  it('falls back to a line break (\\n) when no paragraph break fits', () => {
    const text = 'line one\nline two';
    // limit 9 — no '\n\n' within 9, but '\n' at index 8.
    const chunks = chunkText(text, 9);
    assert.equal(chunks[0], 'line one');
    assert.equal(chunks[1], 'line two');
  });

  it('hard-cuts when no break is available within the limit', () => {
    const text = 'abcdefghijklmnop';
    // limit 5 — no \n\n or \n. Hard cut at 5.
    const chunks = chunkText(text, 5);
    assert.deepEqual(chunks, ['abcde', 'fghij', 'klmno', 'p']);
  });

  it('handles trailing remainder shorter than limit', () => {
    const text = 'a'.repeat(15);
    const chunks = chunkText(text, 10);
    assert.deepEqual(chunks, ['a'.repeat(10), 'a'.repeat(5)]);
  });

  it('strips leading newlines off subsequent chunks after a cut', () => {
    // text: 'first\n\n\nsecond', limit 7
    // lastIndexOf('\n\n', 7) finds the \n\n starting at index 6 (within <=7),
    // so cut=6; chunk[0]='first\n'; the remainder '\nsecond' has its leading
    // \n stripped → 'second'.
    const chunks = chunkText('first\n\n\nsecond', 7);
    assert.deepEqual(chunks, ['first\n', 'second']);
  });
});
