import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * 体检面板的深色有两条路（显式深色 / 跟随系统，见 tokens.css 的注释），
 * 任何写死的颜色都只在其中一条上成立——另一条会顶着浅色值翻车。
 * diagnostics.css 只允许用 tokens.css 的变量；注释除外（说明文字允许提颜色名）。
 */
describe('diagnostics.css tokens 守卫', () => {
  it('diagnostics.css 的注释之外不出现写死的颜色', () => {
    const css = readFileSync(new URL('../src/styles/diagnostics.css', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});
