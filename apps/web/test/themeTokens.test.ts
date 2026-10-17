import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * tokens.css 里的深色调色板写了两份，服务两条不同的路径：
 *
 *   [data-theme="dark"]                       用户手动选「深色」→ html 带属性
 *   @media (prefers-color-scheme: dark)       「跟随系统」+ 深色系统 → html 无属性
 *
 * 两份必须逐条一致，否则同一台深色机器上，仅因用户选了「跟随系统」而非「深色」，
 * 界面就会换一套配色。默认设置恰恰是「跟随系统」——mac 上多数深色用户走的都是第二条。
 *
 * 实测踩过：媒体查询那份只同步到中性色 + accent，漏了 amber/red/green/blue/purple
 * 五组语义色。声明缺失不会报错，只会回落到 :root 的**浅色**值 —— 于是深色卡片上
 * 长出奶白色块，Star 引导条 hover 变成 #eceae6 文字压在 #fdf5e8 底上（对比度 1.11，
 * 字看不见）。同批受害的还有红/绿/蓝/紫底的状态条与徽标，且全部只在这条路径上翻车，
 * 手动选深色时一切正常 —— 这种「两条路只有一条坏」的缺口，肉眼和常规截图都容易漏掉。
 *
 * 这里只断言「两份声明集合相同」，不锁具体色值：改配色不会误伤，但任何一侧新增/
 * 删除 token 而忘了另一侧，都会当场失败并指名道姓。
 */

const cssPath = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

/** 取出 `selector { ... }` 的块体（花括号配平，能穿透嵌套的 @media）。 */
function extractBlock(source: string, selector: string): string {
  const at = source.indexOf(selector);
  assert.notStrictEqual(at, -1, `tokens.css 里找不到选择器 ${selector}`);
  const open = source.indexOf('{', at + selector.length);
  assert.notStrictEqual(open, -1, `${selector} 后面没有 {`);

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`${selector} 的块没有闭合`);
}

/** 块里声明的自定义属性名（不含值）。 */
function declaredProps(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]!));
}

describe('theme tokens', () => {
  const explicitDark = declaredProps(extractBlock(css, '[data-theme="dark"]'));
  const systemDark = declaredProps(
    extractBlock(extractBlock(css, '@media (prefers-color-scheme: dark)'), 'html:not([data-theme])'),
  );

  it('两份深色调色板声明同一组 token', () => {
    const missing = [...explicitDark].filter((p) => !systemDark.has(p)).sort();
    const extra = [...systemDark].filter((p) => !explicitDark.has(p)).sort();

    assert.deepStrictEqual(
      { missing, extra },
      { missing: [], extra: [] },
      [
        '「跟随系统」的深色媒体查询与 [data-theme="dark"] 已经不一致：',
        missing.length ? `  只在手动深色里声明（跟随系统会回落到浅色值）：${missing.join(', ')}` : '',
        extra.length ? `  只在跟随系统里声明：${extra.join(', ')}` : '',
        '修法：把两份改成同一组，见 tokens.css 媒体查询上方的注释。',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

  it('语义色的深色值没漏声明（浅色值在深色底上会成为隐形文字）', () => {
    // 上一组只管「两份深色互相一致」，管不到「两份都漏了」——新加一个 --teal-bg 只写进
    // :root 时，两条深色路径会一起回落到浅色值，界面上又是一块浅底浅字。
    // 所以这里以 :root 为基准：凡是语义族里声明过的，两个深色块都得给出深色值。
    // 只查语义色族，不查 --selected / --radius* / 字体这些**本就共用**的 token，
    // 免得为了过测试去补一堆没意义的重复声明。
    const root = declaredProps(extractBlock(css, ':root'));
    const families = ['accent', 'green', 'blue', 'purple', 'red', 'amber'];
    const suffixes = ['', '-bg', '-border', '-soft', '-tint', '-strong'];

    const missing: string[] = [];
    for (const family of families) {
      for (const suffix of suffixes) {
        const token = `--${family}${suffix}`;
        if (!root.has(token)) continue;
        if (!explicitDark.has(token)) missing.push(`${token} → [data-theme="dark"]`);
        if (!systemDark.has(token)) missing.push(`${token} → 跟随系统的深色`);
      }
    }
    assert.deepStrictEqual(missing, [], `深色主题缺这些语义色的声明：\n  ${missing.join('\n  ')}`);
  });
});
