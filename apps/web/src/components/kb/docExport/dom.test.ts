import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ExportError, isEmptyExport, planPages, utf8ToBase64 } from './dom.ts';
import { EXPORT_FOOTER_HEIGHT, EXPORT_PADDING_TOP, rangeHeight } from './layout.ts';

describe('ExportError', () => {
  it('keeps the machine-readable code', () => {
    const err = new ExportError('no-output', 'empty');
    assert.strictEqual(err.code, 'no-output');
    assert.strictEqual(err.name, 'ExportError');
    assert.ok(err instanceof Error);
  });
});

describe('isEmptyExport', () => {
  it('没有正文块就是空', () => {
    assert.strictEqual(isEmptyExport(0, false), true);
  });

  it('头卡不算内容：只有头卡仍然是空', () => {
    assert.strictEqual(isEmptyExport(1, true), true);
  });

  it('有正文就不算空（无论有没有头卡）', () => {
    assert.strictEqual(isEmptyExport(1, false), false);
    assert.strictEqual(isEmptyExport(2, true), false);
  });
});

describe('utf8ToBase64', () => {
  it('encodes multi-byte CJK without corrupting it', () => {
    const base64 = utf8ToBase64('文档导出');
    assert.strictEqual(Buffer.from(base64, 'base64').toString('utf8'), '文档导出');
  });

  it('handles inputs larger than one chunk', () => {
    const input = 'a'.repeat(100_000);
    assert.strictEqual(Buffer.from(utf8ToBase64(input), 'base64').toString('utf8'), input);
  });

  it('produces plain base64 with no data-url prefix', () => {
    assert.match(utf8ToBase64('<svg/>'), /^[A-Za-z0-9+/]+=*$/);
  });
});

describe('planPages', () => {
  const BUDGET = 7248;

  it('plans a normal document as one full page with a footer', () => {
    const rects = [
      { top: 0, height: 1000 },
      { top: 1000, height: 1000 },
      { top: 2000, height: 1000 },
    ];
    const pages = planPages(rects, BUDGET);

    assert.strictEqual(pages.length, 1);
    assert.deepStrictEqual(pages[0], {
      from: 0,
      to: 3,
      bodyHeight: EXPORT_PADDING_TOP + 3000,
      viewBoxY: 0,
      viewBoxHeight: EXPORT_PADDING_TOP + 3000 + EXPORT_FOOTER_HEIGHT,
      contentHeight: EXPORT_PADDING_TOP + 3000,
    });
  });

  it('plans multiple normal pages, each starting its own body at zero', () => {
    const rects = [
      { top: 0, height: 4000 },
      { top: 4000, height: 4000 },
      { top: 8000, height: 1000 },
    ];
    const pages = planPages(rects, BUDGET);

    assert.strictEqual(pages.length, 2);
    assert.deepStrictEqual(pages[0], {
      from: 0,
      to: 1,
      bodyHeight: EXPORT_PADDING_TOP + rangeHeight(rects, 0, 1),
      viewBoxY: 0,
      viewBoxHeight: EXPORT_PADDING_TOP + rangeHeight(rects, 0, 1) + EXPORT_FOOTER_HEIGHT,
      contentHeight: EXPORT_PADDING_TOP + rangeHeight(rects, 0, 1),
    });

    const second = pages[1];
    assert.ok(second.from > 0);
    assert.strictEqual(second.from, 1);
    assert.strictEqual(second.to, 3);
    assert.strictEqual(second.bodyHeight, EXPORT_PADDING_TOP + rangeHeight(rects, 1, 3));
    assert.strictEqual(second.viewBoxY, 0);
    assert.strictEqual(
      second.viewBoxHeight,
      EXPORT_PADDING_TOP + rangeHeight(rects, 1, 3) + EXPORT_FOOTER_HEIGHT,
    );
    assert.strictEqual(second.contentHeight, EXPORT_PADDING_TOP + rangeHeight(rects, 1, 3));
  });

  it('slices a first-block oversized block from the page top and keeps a footer band', () => {
    const pages = planPages([{ top: 0, height: 9000 }], BUDGET);
    const slices = pages.filter((page) => page.viewBoxY !== 0);

    assert.strictEqual(slices.length, 2);
    assert.deepStrictEqual(
      slices.map((page) => page.viewBoxY),
      [EXPORT_PADDING_TOP, EXPORT_PADDING_TOP + BUDGET],
    );
    assert.deepStrictEqual(
      slices.map((page) => page.contentHeight),
      [BUDGET, 9000 - BUDGET],
    );
    // 切片页也有页脚带：可见高度 + 88 = viewBox 高度。
    assert.deepStrictEqual(
      slices.map((page) => page.viewBoxHeight),
      [BUDGET + EXPORT_FOOTER_HEIGHT, 9000 - BUDGET + EXPORT_FOOTER_HEIGHT],
    );
  });

  it('does not add the oversized block offset within the whole document', () => {
    // 第二块超高：它在克隆容器里已被重新挂到顶部，页面坐标从 paddingTop 起算，
    // 不能再加它在原文档里的 100px 偏移，否则每张切片都整体下移、越切越空。
    const rects = [
      { top: 0, height: 100 },
      { top: 100, height: 9000 },
    ];
    const pages = planPages(rects, BUDGET);

    assert.strictEqual(pages.length, 3);
    assert.deepStrictEqual(pages[0], {
      from: 0,
      to: 1,
      bodyHeight: EXPORT_PADDING_TOP + 100,
      viewBoxY: 0,
      viewBoxHeight: EXPORT_PADDING_TOP + 100 + EXPORT_FOOTER_HEIGHT,
      contentHeight: EXPORT_PADDING_TOP + 100,
    });

    const slices = pages.slice(1);
    assert.deepStrictEqual(
      slices.map((page) => page.viewBoxY),
      [EXPORT_PADDING_TOP, EXPORT_PADDING_TOP + BUDGET],
    );
    assert.deepStrictEqual(
      slices.map((page) => ({
        from: page.from,
        to: page.to,
        contentHeight: page.contentHeight,
      })),
      [
        { from: 1, to: 2, contentHeight: BUDGET },
        { from: 1, to: 2, contentHeight: 9000 - BUDGET },
      ],
    );
    assert.deepStrictEqual(
      slices.map((page) => page.bodyHeight),
      [EXPORT_PADDING_TOP + 9000, EXPORT_PADDING_TOP + 9000],
    );
  });
});

describe('planPages 固定页高（card34）', () => {
  it('内容不满一页时页高仍固定，遮罩补底量正确', () => {
    const rects = [
      { top: 0, height: 600 },
      { top: 600, height: 600 },
    ];
    const pages = planPages(rects, 1288, 1440);

    assert.strictEqual(pages.length, 1);
    assert.strictEqual(pages[0].viewBoxHeight, 1440);
    assert.strictEqual(pages[0].contentHeight, EXPORT_PADDING_TOP + 1200);
  });

  it('超高块切片：每片页高都固定，末片短也补满', () => {
    const pages = planPages([{ top: 0, height: 3000 }], 1288, 1440);

    assert.strictEqual(pages.length, 3);
    for (const p of pages) assert.strictEqual(p.viewBoxHeight, 1440);
    assert.strictEqual(pages[2]?.contentHeight, 424);
  });

  it('不传固定页高时与一期行为完全一致', () => {
    const rects = [
      { top: 0, height: 600 },
      { top: 600, height: 600 },
    ];
    const pages = planPages(rects, 1288);

    assert.strictEqual(
      pages[0].viewBoxHeight,
      EXPORT_PADDING_TOP + 1200 + EXPORT_FOOTER_HEIGHT,
    );
  });
});
