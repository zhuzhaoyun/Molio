import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isExternalHttpUrl, shouldHandleExternalClick } from './externalLinks.ts';

const ORIGIN = 'http://localhost:3100';

describe('shouldHandleExternalClick', () => {
  const plain = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false };

  it('普通左键点击由处理器接管', () => {
    assert.equal(shouldHandleExternalClick(plain), true);
  });

  it('修饰键点击交回浏览器原生语义（后台新标签 / 新窗口）', () => {
    assert.equal(shouldHandleExternalClick({ ...plain, ctrlKey: true }), false);
    assert.equal(shouldHandleExternalClick({ ...plain, metaKey: true }), false);
    assert.equal(shouldHandleExternalClick({ ...plain, shiftKey: true }), false);
  });

  it('非左键、已被其它处理器处理过的点击不接管', () => {
    assert.equal(shouldHandleExternalClick({ ...plain, button: 1 }), false);
    assert.equal(shouldHandleExternalClick({ ...plain, defaultPrevented: true }), false);
  });
});

describe('isExternalHttpUrl', () => {
  it('treats absolute http(s) URLs on another origin as external', () => {
    assert.equal(isExternalHttpUrl('https://example.com/page', ORIGIN), true);
    assert.equal(isExternalHttpUrl('http://example.com', ORIGIN), true);
    // Same host, different port = different origin
    assert.equal(isExternalHttpUrl('http://localhost:5173/', ORIGIN), true);
  });

  it('treats same-origin and relative URLs as internal', () => {
    assert.equal(isExternalHttpUrl('http://localhost:3100/knowledge', ORIGIN), false);
    assert.equal(isExternalHttpUrl('/knowledge?vault=1', ORIGIN), false);
    assert.equal(isExternalHttpUrl('#section', ORIGIN), false);
    assert.equal(isExternalHttpUrl('notes/todo.md', ORIGIN), false);
  });

  it('rejects non-http(s) schemes', () => {
    assert.equal(isExternalHttpUrl('mailto:a@b.com', ORIGIN), false);
    assert.equal(isExternalHttpUrl('tel:123', ORIGIN), false);
    assert.equal(isExternalHttpUrl('ftp://example.com/f', ORIGIN), false);
    assert.equal(isExternalHttpUrl('javascript:alert(1)', ORIGIN), false);
    assert.equal(isExternalHttpUrl('molio://open/vault/1', ORIGIN), false);
  });

  it('returns false for unparseable input', () => {
    assert.equal(isExternalHttpUrl('', ORIGIN), false);
    assert.equal(isExternalHttpUrl('http://', ORIGIN), false);
  });
});
