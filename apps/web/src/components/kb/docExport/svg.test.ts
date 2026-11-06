import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildPageSvg, escapeXml } from './svg.ts';
import { planPages } from './dom.ts';
import {
  EXPORT_FOOTER_HEIGHT,
  EXPORT_PADDING_X,
  EXPORT_SCALE,
  EXPORT_WIDTH,
  WATERMARK,
} from './layout.ts';

const baseOptions = {
  bodyHtml: '<section class="container"><h1>标题</h1></section>',
  css: '.molio-doc-export { color: #fff; }',
  background: '#1e1e1e',
  scale: EXPORT_SCALE,
  bodyHeight: 800,
  viewBoxY: 0,
  viewBoxHeight: 900,
  contentHeight: 800,
};

describe('escapeXml', () => {
  it('escapes markup-significant characters', () => {
    assert.strictEqual(escapeXml(`<a & "b" 'c'>`), '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  });
});

describe('buildPageSvg', () => {
  it('rasterizes at the requested scale through the viewBox', () => {
    const svg = buildPageSvg(baseOptions);
    assert.strictEqual(EXPORT_SCALE, 2);
    assert.ok(svg.startsWith('<svg '), svg.slice(0, 40));
    assert.ok(svg.includes(`width="${EXPORT_WIDTH * EXPORT_SCALE}"`), svg);
    assert.ok(svg.includes(`height="${baseOptions.viewBoxHeight * EXPORT_SCALE}"`), svg);
    assert.ok(
      svg.includes(`viewBox="0 0 ${EXPORT_WIDTH} ${baseOptions.viewBoxHeight}"`),
      svg,
    );
  });

  it('rounds fractional heights once so the raster aspect ratio matches the viewBox', () => {
    for (const inputHeight of [900.4, 900.6]) {
      const svg = buildPageSvg({ ...baseOptions, viewBoxHeight: inputHeight });
      const match = svg.match(
        /<svg [^>]*width="([\d.]+)" height="([\d.]+)" viewBox="([^"]+)"/,
      );
      assert.ok(match, svg);
      const pixelWidth = Number(match[1]);
      const pixelHeight = Number(match[2]);
      const [, , viewBoxWidth, viewBoxHeight] = match[3].split(' ').map(Number);
      assert.ok(
        Number.isInteger(viewBoxHeight),
        `viewBox height must be an integer, got ${match[3]}`,
      );
      assert.strictEqual(viewBoxWidth, EXPORT_WIDTH);
      assert.strictEqual(pixelHeight, viewBoxHeight * EXPORT_SCALE);
      assert.strictEqual(pixelHeight / pixelWidth, viewBoxHeight / viewBoxWidth);
      assert.strictEqual(viewBoxHeight, Math.round(inputHeight));
      assert.ok(
        svg.includes(`<rect x="0" y="0" width="${EXPORT_WIDTH}" height="${viewBoxHeight}"`),
        svg,
      );
    }
  });

  it('paints the background over the visible slice', () => {
    const svg = buildPageSvg({ ...baseOptions, viewBoxY: 7000, viewBoxHeight: 400 });
    assert.ok(
      svg.includes(
        `<rect x="0" y="7000" width="${EXPORT_WIDTH}" height="400" fill="#1e1e1e"/>`,
      ),
      svg,
    );
  });

  it('puts the body in an XHTML foreignObject with the export class', () => {
    const svg = buildPageSvg(baseOptions);
    assert.ok(svg.includes('xmlns="http://www.w3.org/1999/xhtml"'), svg);
    assert.ok(svg.includes('class="molio-doc-export"'), svg);
    assert.ok(svg.includes(baseOptions.bodyHtml), svg);
  });

  it('embeds CSS inside CDATA and survives a literal CDATA terminator', () => {
    const svg = buildPageSvg({ ...baseOptions, css: 'a{content:"]]>";}' });
    assert.ok(svg.includes('<![CDATA['), svg);
    assert.ok(svg.includes(']]]]><![CDATA[>'), svg);
  });

  it('omits the footer when none is supplied', () => {
    assert.ok(!buildPageSvg(baseOptions).includes('<text'));
    assert.ok(!buildPageSvg(baseOptions).includes('<rect x="0" y="800"'));
  });

  it('renders only the watermark on a single-page export', () => {
    const svg = buildPageSvg({
      ...baseOptions,
      footer: { page: 1, total: 1, watermark: WATERMARK, ink: '#fff' },
    });
    assert.ok(svg.includes(`>${WATERMARK}</text>`), svg);
    assert.ok(!/\d+ \/ \d+/.test(svg), `single page must not print a page number: ${svg}`);
  });

  it('masks the content that would bleed into the footer band', () => {
    // 切片页：viewBox 从 7064 起（64 + 7000），可见内容到 7064+800，
    // 页脚带 88 由遮罩盖住，正文不会从页码下面穿出来。
    const svg = buildPageSvg({
      ...baseOptions,
      viewBoxY: 7064,
      viewBoxHeight: 888,
      contentHeight: 800,
      footer: { page: 2, total: 3, watermark: WATERMARK, ink: '#fff' },
    });
    assert.ok(
      svg.includes(
        `<rect x="0" y="7864" width="${EXPORT_WIDTH}" height="88" fill="#1e1e1e"/>`,
      ),
      svg,
    );
    // 遮罩必须排在 foreignObject 之后、页脚文字之前
    assert.ok(svg.indexOf('7864"') > svg.indexOf('</foreignObject>'), svg);
    assert.ok(svg.indexOf('7864"') < svg.indexOf('<text'), svg);
  });

  it('skips the mask when there is no footer band left', () => {
    const svg = buildPageSvg({
      ...baseOptions,
      viewBoxY: 7000,
      viewBoxHeight: 400,
      contentHeight: 400,
      footer: { page: 1, total: 2, watermark: WATERMARK, ink: '#fff' },
    });
    assert.ok(!svg.includes('<rect x="0" y="7400"'), svg);
    assert.ok(svg.includes('>1 / 2</text>'), svg);
  });

  it('writes the watermark and page numbers into the footer', () => {
    const svg = buildPageSvg({
      ...baseOptions,
      footer: { page: 2, total: 5, watermark: WATERMARK, ink: 'rgba(255, 255, 255, 0.55)' },
    });
    assert.strictEqual(WATERMARK, 'Molio');
    assert.ok(svg.includes(`>${WATERMARK}</text>`), svg);
    assert.ok(svg.includes('>2 / 5</text>'), svg);
    assert.ok(svg.includes('text-anchor="end"'), svg);
  });

  it('keeps the footer inside the reserved footer band', () => {
    const viewBoxHeight = 900;
    const svg = buildPageSvg({
      ...baseOptions,
      viewBoxHeight,
      footer: { page: 1, total: 2, watermark: WATERMARK, ink: '#fff' },
    });
    assert.strictEqual(EXPORT_FOOTER_HEIGHT, 88);
    const baselines = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"/g)];
    assert.strictEqual(baselines.length, 2, svg);
    for (const match of baselines) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      assert.ok(x >= 0 && x <= EXPORT_WIDTH, `footer x out of page: ${x}`);
      assert.ok(
        y >= viewBoxHeight - EXPORT_FOOTER_HEIGHT && y <= viewBoxHeight,
        `footer baseline ${y} outside footer band`,
      );
    }
    const xs = baselines.map((match) => Number(match[1]));
    assert.deepStrictEqual(xs, [EXPORT_PADDING_X, EXPORT_WIDTH - EXPORT_PADDING_X]);
  });

  it('escapes the footer text instead of injecting markup', () => {
    const svg = buildPageSvg({
      ...baseOptions,
      footer: { page: 1, total: 1, watermark: '<b>', ink: '#000' },
    });
    assert.ok(svg.includes('&lt;b&gt;'), svg);
    assert.ok(!svg.includes('<b>'), svg);
  });
});

// ── 页脚几何不变量（防「图谱出图式」溢出回归）──
//
// 2026-10-24 图谱出图的教训：页脚「预留」与「消费」的对账只活在人脑里，
// 常数一改（带高、基线偏移、字号任意动一个），基线就沉到页底之下，
// 图例和署名被裁掉近半。上面那个「footer inside the reserved band」用例
// 只钉了合成形态的基线位置；这里用真实管线（planPages → buildPageSvg）
// 把对账钉死在三种真实页面形态上：长图正常页 / 超高块切片页 / 3:4 竖卡。
//   1) 基线 + CJK 字身下探（~0.25em）不得越过页底 —— 图谱 bug 的精确死法；
//   2) 页脚字号必须严格小于页脚带高（带高 = 页底 − 正文可见底边）；
//   3) 基线必须落在页脚带内（正文可见底边之下）。

describe('页脚几何不变量', () => {
  // 第二块 8000 高于长图预算（7248）也高于 3:4 预算（1288）：
  // 两种版式都天然产出「正常页 + 超高块切片页」的完整形态组合。
  // （第一版这里写 3000，只有 3:4 出了切片页、长图切片形态漏测——
  //   用例数对不上时才暴露。）
  const rects = [
    { top: 0, height: 1000 },
    { top: 1000, height: 8000 },
  ];
  const shapes = [
    ...planPages(rects).map((plan, i) => ({ name: `长图第${i + 1}页`, plan })),
    ...planPages(rects, 1288, 1440).map((plan, i) => ({ name: `3:4 第${i + 1}页`, plan })),
  ];

  for (const { name, plan } of shapes) {
    it(`${name}：字身不出页底、字号小于带高、基线在带内`, () => {
      const svg = buildPageSvg({
        ...baseOptions,
        bodyHeight: plan.bodyHeight,
        viewBoxY: plan.viewBoxY,
        viewBoxHeight: plan.viewBoxHeight,
        contentHeight: plan.contentHeight,
        footer: { page: 1, total: 2, watermark: WATERMARK, ink: '#fff' },
      });

      const viewBox = svg.match(/viewBox="[^"]* ([\d.]+) ([\d.]+) ([\d.]+)"/);
      assert.ok(viewBox, svg.slice(0, 200));
      const viewBoxY = Number(viewBox[1]);
      const viewBoxH = Number(viewBox[3]);
      const bottom = viewBoxY + viewBoxH;

      const footer = svg.match(/<text x="[\d.]+" y="([\d.]+)" [^>]*font-size="(\d+)"/);
      assert.ok(footer, svg.slice(-400));
      const baseline = Number(footer[1]);
      const font = Number(footer[2]);
      const band = bottom - (viewBoxY + plan.contentHeight);

      assert.ok(
        baseline + font * 0.25 <= bottom,
        `${name}: 基线 ${baseline} + 字身下探越出页底 ${bottom}（font=${font}）`,
      );
      assert.ok(font < band, `${name}: 页脚字号 ${font} 不小于带高 ${band}`);
      assert.ok(
        baseline >= viewBoxY + plan.contentHeight,
        `${name}: 基线 ${baseline} 高于正文可见底边 ${viewBoxY + plan.contentHeight}`,
      );
    });
  }
});
