import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CONTENT_WIDTH,
  EXPORT_FOOTER_HEIGHT,
  EXPORT_PADDING_TOP,
  EXPORT_WIDTH,
  MAX_PAGE_HEIGHT,
  PAGE_BUDGET,
  composeExportCss,
  docExportFileName,
  exportPresetParams,
  footerInkFor,
  paginateBlocks,
  rangeHeight,
  rewriteScope,
  sliceVerticalRects,
  type BlockRect,
} from './layout.ts';

describe('export constants', () => {
  it('derive the page budget from the exported page geometry', () => {
    assert.strictEqual(EXPORT_WIDTH, 1080);
    assert.strictEqual(CONTENT_WIDTH, 952);
    assert.strictEqual(PAGE_BUDGET, MAX_PAGE_HEIGHT - EXPORT_PADDING_TOP - EXPORT_FOOTER_HEIGHT);
    assert.strictEqual(PAGE_BUDGET, 7248);
  });
});

describe('rewriteScope', () => {
  it('moves #output and :root rules onto the export root class', () => {
    const css = ':root { --x: 1; }\n#output h1 { color: red; }\n#output { font-size: 16px; }';
    const out = rewriteScope(css);
    assert.ok(out.includes('.molio-doc-export { --x: 1; }'), out);
    assert.ok(out.includes('.molio-doc-export h1 { color: red; }'), out);
    assert.ok(out.includes('.molio-doc-export { font-size: 16px; }'), out);
    assert.ok(!out.includes('#output'), out);
  });

  it('does not touch selectors that merely start with the same characters', () => {
    const css = '#outputX { color: red; }\n:rooted { color: blue; }';
    assert.strictEqual(rewriteScope(css), css);
  });
});

describe('composeExportCss', () => {
  const parts = {
    theme: ':root { --md-font-size: 16px; }\n#output h1 { color: red; }',
    inline: '#output p { margin: 1em 0; }',
    color: 'rgb(230, 230, 230)',
    background: '#1e1e1e',
    accent: 'rgb(99, 102, 241)',
    code: {
      fontFamily: "ui-monospace, 'SF Mono', monospace",
      background: '#f4f2ef',
      color: '#1a1917',
    },
  };

  it('writes the captured foreground and background onto the export root', () => {
    // 深色模式的命门：正文颜色在实时页面是继承来的，SVG 里继承不到
    const css = composeExportCss(parts);
    assert.ok(css.includes('color: rgb(230, 230, 230)'), css);
    assert.ok(css.includes('background: #1e1e1e'), css);
  });

  it('scopes every theme rule and variable to the export root', () => {
    const css = composeExportCss(parts);
    assert.ok(css.includes('.molio-doc-export { --md-font-size: 16px; }'), css);
    assert.ok(css.includes('.molio-doc-export h1 { color: red; }'), css);
    assert.ok(css.includes('.molio-doc-export p { margin: 1em 0; }'), css);
    assert.ok(!css.includes('#output'), css);
    assert.ok(!css.includes(':root'), css);
  });

  it('styles wiki links even though they live outside the theme CSS', () => {
    const css = composeExportCss(parts);
    assert.ok(css.includes('.molio-doc-export a.kb-wiki-link'), css);
    assert.ok(css.includes('rgb(99, 102, 241)'), css);
  });

  it('carries the base.css box-sizing and code rules into the export cascade', () => {
    // 测量宿主吃得到 base.css、SVG 吃不到；少这两条就会「量的矮、画的高」，
    // 分页按错高度裁切，代码块底部静默丢失。
    const css = composeExportCss(parts);
    assert.ok(css.includes('.molio-doc-export * { box-sizing: border-box; }'), css);
    assert.ok(
      css.includes(
        ".molio-doc-export code { font-family: ui-monospace, 'SF Mono', monospace;" +
          ' background: #f4f2ef; color: #1a1917;' +
          ' padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }',
      ),
      css,
    );
    // font-size 必须是相对值：live 的 0.92em 乘在 pre 的 90% 上，复制成 px 两边又不同级联。
    assert.ok(css.includes('font-size: 0.92em'), css);
    // 兼容规则必须排在主题 CSS 之前，主题的 .codespan / pre > code 才能继续优先。
    assert.ok(css.indexOf('.molio-doc-export code') < css.indexOf('-md-font-size'), css);
  });

  it('wraps long code lines after the theme CSS so static images do not clip', () => {
    const css = composeExportCss(parts);
    const wrap = css.indexOf('.molio-doc-export pre.code__pre > code');
    assert.ok(wrap > css.indexOf('-md-font-size'), 'wrap override must follow the theme');
    assert.ok(
      css.includes(
        '.molio-doc-export pre.code__pre > code,\n' +
          '.molio-doc-export .hljs.code__pre > code {\n' +
          '  white-space: pre-wrap;\n' +
          '  overflow-wrap: anywhere;\n' +
          '}',
      ),
      css,
    );
  });

  it('composeExportCss 无条件含头卡规则（头卡元素缺席时无害）', () => {
    // 亮底：meta 文字取 footerInkFor 的半透明黑
    const css = composeExportCss({ ...parts, background: '#ffffff' });
    assert.match(css, /\.molio-doc-export \.molio-export-head \{/);
    assert.match(css, /\.molio-export-head__title/);
    assert.match(css, /__meta[\s\S]*?rgba\(0, 0, 0, 0\.45\)/);
    // 强调色走 doocs 主题自己的主色变量（与正文标题下划线同源），应用 accent 只做兜底
    assert.match(css, /border-bottom: 2px solid var\(--md-primary-color, rgb\(99, 102, 241\)\)/);
    assert.match(css, /__tags span \{[\s\S]*?border: 1px solid var\(--md-primary-color/);
  });
});

describe('paginateBlocks', () => {
  const blocks = (heights: number[]): BlockRect[] => {
    let top = 0;
    return heights.map((height) => {
      const rect = { top, height };
      top += height;
      return rect;
    });
  };

  it('keeps everything on one page when it fits', () => {
    assert.deepStrictEqual(paginateBlocks(blocks([100, 200, 300]), 1000), [[0, 3]]);
  });

  it('breaks before the block that would overflow', () => {
    assert.deepStrictEqual(paginateBlocks(blocks([100, 200, 300, 100]), 400), [
      [0, 2],
      [2, 4],
    ]);
  });

  it('gives an oversized block its own page instead of dropping it', () => {
    // 块顶边 0 / 100 / 1000；900 高的块放不进任何一页，只能独占
    assert.deepStrictEqual(paginateBlocks(blocks([100, 900, 100]), 400), [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('never produces an empty page', () => {
    assert.deepStrictEqual(paginateBlocks([], 400), []);
  });
});

describe('rangeHeight', () => {
  it('measures from the first block top to the last block bottom', () => {
    const blocks = [
      { top: 0, height: 100 },
      { top: 120, height: 50 },
      { top: 200, height: 30 },
    ];
    assert.strictEqual(rangeHeight(blocks, 0, 2), 170);
    assert.strictEqual(rangeHeight(blocks, 1, 3), 110);
  });
});

describe('sliceVerticalRects', () => {
  it('slices an oversized block into consecutive full-height rectangles', () => {
    assert.deepStrictEqual(sliceVerticalRects(1000, 400), [
      { top: 0, height: 400 },
      { top: 400, height: 400 },
      { top: 800, height: 200 },
    ]);
  });

  it('rounds fractional heights up so nothing is clipped away', () => {
    assert.deepStrictEqual(sliceVerticalRects(400.2, 400), [
      { top: 0, height: 400 },
      { top: 400, height: 1 },
    ]);
  });

  it('always returns at least one slice for empty content', () => {
    assert.deepStrictEqual(sliceVerticalRects(0, 400), [{ top: 0, height: 1 }]);
  });
});

describe('exportPresetParams', () => {
  it('long 是现状默认：页高上限 7400、预算 7248', () => {
    assert.deepStrictEqual(exportPresetParams('long'), {
      pageHeight: 7400,
      pageBudget: 7248,
    });
    assert.deepStrictEqual(exportPresetParams(), { pageHeight: 7400, pageBudget: 7248 });
  });

  it('card34：1080×1440 固定页，预算扣顶边距与页脚带', () => {
    assert.deepStrictEqual(exportPresetParams('card34'), {
      pageHeight: 1440,
      pageBudget: 1288,
    });
  });
});

describe('footerInkFor', () => {
  it('uses dark ink on light backgrounds', () => {
    assert.match(footerInkFor('#ffffff'), /rgba\(0/);
    assert.match(footerInkFor('rgb(250, 250, 250)'), /rgba\(0/);
  });

  it('uses light ink on dark backgrounds', () => {
    assert.match(footerInkFor('#111111'), /rgba\(255/);
    assert.match(footerInkFor('rgba(20, 20, 24, 0.9)'), /rgba\(255/);
  });

  it('falls back to neutral grey for formats it cannot parse', () => {
    assert.strictEqual(footerInkFor('transparent'), '#8a8a8a');
    assert.strictEqual(footerInkFor('hsl(0 0% 50%)'), '#8a8a8a');
  });

  it('expands 3-digit hex', () => {
    assert.match(footerInkFor('#fff'), /rgba\(0/);
    assert.match(footerInkFor('#000'), /rgba\(255/);
  });
});

describe('docExportFileName', () => {
  it('stamps date, time and title', () => {
    assert.strictEqual(
      docExportFileName('法考 刑法', new Date(2026, 9, 19, 9, 5)),
      'molio-doc-法考-刑法-20261019-0905.png',
    );
  });

  it('adds a page suffix only for multi-page exports', () => {
    const date = new Date(2026, 9, 19, 9, 5);
    assert.strictEqual(docExportFileName('a', date, 1, 3), 'molio-doc-a-20261019-0905-1.png');
    assert.strictEqual(docExportFileName('a', date, 1, 1), 'molio-doc-a-20261019-0905.png');
    assert.strictEqual(docExportFileName('a', date), 'molio-doc-a-20261019-0905.png');
  });

  it('falls back to a generic stem for blank titles', () => {
    assert.strictEqual(
      docExportFileName('   ', new Date(2026, 9, 19, 9, 5)),
      'molio-doc-20261019-0905.png',
    );
  });

  it('contains nothing a filesystem would reject', () => {
    const name = docExportFileName('a/b:c*?"<>|d', new Date(2026, 11, 31, 23, 59), 12, 12);
    assert.match(name, /^[A-Za-z0-9._-]+$/);
  });
});
