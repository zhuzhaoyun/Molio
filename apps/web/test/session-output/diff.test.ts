// apps/web/test/session-output/diff.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { lineDiff, hasRealChange } from '../../src/utils/diff.ts';

describe('lineDiff', () => {
  it('单行替换 → 一删一增', () => {
    const d = lineDiff('内容页共 318 页。', '内容页共 319 页。');
    assert.deepEqual(d, [
      { type: 'del', text: '内容页共 318 页。' },
      { type: 'add', text: '内容页共 319 页。' },
    ]);
  });

  it('新增一行 → 仅增', () => {
    const d = lineDiff('a\nb', 'a\nb\nc');
    assert.deepEqual(d, [{ type: 'add', text: 'c' }]);
  });

  it('删除一行 → 仅删', () => {
    const d = lineDiff('a\nb\nc', 'a\nc');
    assert.deepEqual(d, [{ type: 'del', text: 'b' }]);
  });

  it('中间插入：公共头尾保留，只标增行', () => {
    const d = lineDiff('## 新闻\n- 旧条目', '## 新闻\n- 新条目\n- 旧条目');
    assert.deepEqual(d, [{ type: 'add', text: '- 新条目' }]);
  });

  it('逐字相同 → 无增删', () => {
    assert.deepEqual(lineDiff('x\ny', 'x\ny'), []);
  });

  it('CRLF 差异不误报', () => {
    assert.deepEqual(lineDiff('a\r\nb', 'a\nb'), []);
  });
});

describe('hasRealChange', () => {
  it('有增删 → true；逐字相同 → false', () => {
    assert.ok(hasRealChange('a', 'b'));
    assert.ok(!hasRealChange('a', 'a'));
  });
});
