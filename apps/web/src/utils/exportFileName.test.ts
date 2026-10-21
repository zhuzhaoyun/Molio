import { describe, it } from 'node:test';
import assert from 'node:assert';
import { slugifyTitle } from './exportFileName.ts';

describe('slugifyTitle', () => {
  it('keeps ordinary CJK and latin titles readable', () => {
    assert.strictEqual(slugifyTitle('法考 刑法'), '法考-刑法');
    assert.strictEqual(slugifyTitle('graph-export'), 'graph-export');
  });

  it('removes characters Windows rejects', () => {
    assert.strictEqual(slugifyTitle('a/b:c*?"<>|d'), 'a-b-c-d');
    // 控制字符（U+0000–U+001F）与 `<>:"/\|?*` 同属一条替换规则，单独覆盖一次。
    assert.strictEqual(slugifyTitle('a\u0000b'), 'a-b');
  });

  it('collapses whitespace and repeated dashes', () => {
    assert.strictEqual(slugifyTitle('  a   b -- c  '), 'a-b-c');
  });

  it('trims leading and trailing dashes and dots', () => {
    assert.strictEqual(slugifyTitle('-.-name-.-'), 'name');
  });

  it('returns an empty string for blank or missing titles', () => {
    assert.strictEqual(slugifyTitle(''), '');
    assert.strictEqual(slugifyTitle(undefined), '');
    assert.strictEqual(slugifyTitle('///'), '');
  });

  it('caps overlong titles and never ends with a separator', () => {
    // `#` 不是 Windows 非法字符，按「行为不变」的实现会原样保留，无法匹配下面的字符集；
    // 用字母长标题验证限长与首尾分隔符规则。
    const slug = slugifyTitle('a'.repeat(100));
    assert.strictEqual(slug.length, 40);
    assert.match(slug, /^[A-Za-z0-9_-]+$/);
    // 41 字符（空白折成 `-` 后）→ slice 恰好把 `-` 留在末尾 → 末尾回剪必须生效。
    assert.strictEqual(slugifyTitle('a'.repeat(39) + '  b'), 'a'.repeat(39));
  });
});
