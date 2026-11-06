/**
 * markdown.ts 的围栏分段：rule-sandbox 段类型 + 连字符语言名不被截断。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

const { splitContent } = await import('../src/utils/markdown.ts');

describe('splitContent — sandbox segments', () => {
  it('splits a closed rule-sandbox fence into its own segment', () => {
    const segs = splitContent('前言\n```rule-sandbox\n{"version":1}\n```\n后记');
    assert.deepEqual(segs.map((s) => s.type), ['text', 'sandbox', 'text']);
    const sandbox = segs[1];
    assert.equal(sandbox.type, 'sandbox');
    if (sandbox.type !== 'sandbox') throw new Error('expected sandbox segment');
    assert.equal(sandbox.complete, true);
    assert.match(sandbox.raw, /"version":1/);
  });

  it('marks an unclosed fence incomplete and keeps the tail in raw', () => {
    const segs = splitContent('前言\n```rule-sandbox\n{"version":1');
    assert.deepEqual(segs.map((s) => s.type), ['text', 'sandbox']);
    const sandbox = segs[1];
    if (sandbox.type !== 'sandbox') throw new Error('expected sandbox segment');
    assert.equal(sandbox.complete, false);
    assert.match(sandbox.raw, /"version":1/);
  });

  it('leaves ordinary code blocks untouched', () => {
    const segs = splitContent('```ts\nconst x = 1;\n```');
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, 'code');
    if (segs[0].type !== 'code') throw new Error('expected code segment');
    assert.equal(segs[0].lang, 'ts');
  });

  it('does not truncate hyphenated language names', () => {
    // 围栏正则若用 \w*，`objective-c` 会被截成 `objective`。
    const segs = splitContent('```objective-c\nint main(){}\n```');
    assert.equal(segs[0].type, 'code');
    if (segs[0].type !== 'code') throw new Error('expected code segment');
    assert.equal(segs[0].lang, 'objective-c');
    assert.equal(segs[0].code, 'int main(){}\n');
  });

  it('does not eat a leading hyphen of a bare fence whose first line starts with one', () => {
    // 正则若允许语言名以 - 开头，「```- 项目说明」的 `-` 会被吃成语言名。
    const segs = splitContent('```- 项目说明\n内容\n```');
    assert.equal(segs[0].type, 'code');
    if (segs[0].type !== 'code') throw new Error('expected code segment');
    assert.equal(segs[0].lang, '');
    assert.equal(segs[0].code, '- 项目说明\n内容\n');
  });

  it('keeps quiz and sandbox fences independent', () => {
    const segs = splitContent(
      '```quiz\n{"version":1}\n```\n中间\n```rule-sandbox\n{"version":1}\n```',
    );
    assert.deepEqual(segs.map((s) => s.type), ['quiz', 'text', 'sandbox']);
    assert.equal(segs[0].type === 'quiz' && segs[0].complete, true);
    assert.equal(segs[2].type === 'sandbox' && segs[2].complete, true);
  });
});
