import { describe, it } from 'node:test';
import assert from 'node:assert';

const { splitContent } = await import('../src/utils/markdown.ts');

describe('splitContent — quiz fences', () => {
  it('splits a closed quiz fence into a quiz segment', () => {
    const segments = splitContent('前言\n```quiz\n{"version":1}\n```\n后记');
    assert.deepEqual(segments[0], { type: 'text', content: '前言\n' });
    assert.deepEqual(segments[1], { type: 'quiz', raw: '{"version":1}\n', complete: true });
    assert.deepEqual(segments[2], { type: 'text', content: '\n后记' });
  });

  it('marks an unclosed quiz fence as incomplete and keeps the tail', () => {
    const segments = splitContent('```quiz\n{"version":1,');
    assert.deepEqual(segments, [
      { type: 'quiz', raw: '{"version":1,', complete: false },
    ]);
  });

  it('keeps ordinary code fences as code segments', () => {
    const segments = splitContent('```ts\nconst x = 1;\n```');
    assert.deepEqual(segments, [
      { type: 'code', lang: 'ts', code: 'const x = 1;\n' },
    ]);
  });

  it('handles multiple quiz fences in one message', () => {
    const segments = splitContent('```quiz\nA\n```\n中间\n```quiz\nB\n```');
    assert.deepEqual(
      segments.map((segment) => segment.type),
      ['quiz', 'text', 'quiz'],
    );
    assert.equal(segments[0].type === 'quiz' && segments[0].complete, true);
    assert.equal(segments[2].type === 'quiz' && segments[2].raw, 'B\n');
  });

  it('leaves inline backticks and plain text alone', () => {
    const segments = splitContent('用 `quiz` 这个词，但不是围栏。');
    assert.deepEqual(segments, [{ type: 'text', content: '用 `quiz` 这个词，但不是围栏。' }]);
  });
});
