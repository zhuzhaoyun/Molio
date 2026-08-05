import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkdownCard } from '../../../src/core/feishu/card.js';

describe('buildMarkdownCard', () => {
  it('produces a JSON 2.0 card with a single markdown body element', () => {
    const card = buildMarkdownCard('hello **world**');
    assert.equal(card.schema, '2.0');
    assert.equal(card.body.elements.length, 1);
    assert.equal(card.body.elements[0].tag, 'markdown');
    assert.equal(card.body.elements[0].content, 'hello **world**');
  });

  it('passes markdown through verbatim (no escaping or trimming)', () => {
    const md = '# 标题\n\n- 列表项\n\n```js\nconsole.log("hi")\n```\n';
    const card = buildMarkdownCard(md);
    assert.equal(card.body.elements[0].content, md);
  });

  it('serializes to valid JSON that round-trips losslessly', () => {
    // Quotes, backslashes, newlines, tabs, CJK and emoji are exactly what
    // agent output contains — JSON.stringify must escape them and parse must
    // recover the original string byte-for-byte.
    const md = '引号 " 反斜杠 \\ 换行\n制表\t中文 🚀 `code` [链接](https://x.cn)';
    const parsed = JSON.parse(JSON.stringify(buildMarkdownCard(md)));
    assert.equal(parsed.schema, '2.0');
    assert.equal(parsed.body.elements[0].tag, 'markdown');
    assert.equal(parsed.body.elements[0].content, md);
  });

  it('keeps empty markdown empty (placeholder texts stay valid cards)', () => {
    const card = buildMarkdownCard('');
    assert.equal(card.body.elements[0].content, '');
  });
});
