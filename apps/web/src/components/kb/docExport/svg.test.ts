import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildPageSvg, escapeXml } from './svg.ts';
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
