import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CARD_ASPECT_RATIO,
  cardInkFor,
  collectLegend,
  computeCardLayout,
  drawCard,
  pickCoreTopics,
  truncateTopic,
  type CardInk,
  type CardLayout,
} from './exportCard.ts';

/**
 * 「图谱卡片」的纯计算部分：核心主题、图例、墨色、版式几何、绘制调用。
 *
 * 出图的目标不是「更像截图」，而是「截图给不了的」：标题卡（库名/统计）、
 * 核心主题（引擎知道哪几个节点度数最高，截图不知道）、图例（颜色含义）、
 * 版式（生成端排版，不是事后裁）。
 *
 * 这里只测可算的部分；Pixi 取帧与 canvas 合成都是一次性调用，靠 E2E 兜底。
 */

const NODES = [
  { key: 'a', label: '共同犯罪' },
  { key: 'b', label: '主犯' },
  { key: 'c', label: '从犯' },
  { key: 'd', label: '正当防卫' },
  { key: 'x', label: '死链', dead: true },
];

const EDGES = [
  { source: 'a', target: 'b' },
  { source: 'a', target: 'c' },
  { source: 'b', target: 'c' },
  { source: 'd', target: 'a' },
  { source: 'a', target: 'missing' },
  { source: 'x', target: 'a' },
];

// ── pickCoreTopics ──

describe('pickCoreTopics', () => {
  it('ranks by degree over both edge directions', () => {
    // a: a-b, a-c, d-a = 3；b: a-b, b-c = 2；c: a-c, b-c = 2；d: 1
    const topics = pickCoreTopics(NODES, EDGES, 2);
    assert.strictEqual(topics[0], '共同犯罪');
    assert.ok(['主犯', '从犯'].includes(topics[1]), topics[1]);
  });

  it('ignores edges pointing at nodes that are not in the graph', () => {
    const topics = pickCoreTopics(NODES, EDGES, 4);
    assert.ok(!topics.includes('missing'));
  });

  it('never promotes dead-link placeholders to core topics', () => {
    // 死链节点在这张图里是个 hub（度数 2，并列最高）：不过滤就必然进榜
    const nodes = [
      { key: 'x', label: '死链', dead: true },
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ];
    const edges = [
      { source: 'x', target: 'a' },
      { source: 'x', target: 'b' },
      { source: 'a', target: 'b' },
    ];
    assert.ok(!pickCoreTopics(nodes, edges, 3).includes('死链'));
  });

  it('returns nothing when the graph has no links — there is no "core"', () => {
    assert.deepStrictEqual(pickCoreTopics(NODES, [], 3), []);
  });

  it('caps at max and never repeats a label', () => {
    const topics = pickCoreTopics(NODES, EDGES, 3);
    assert.strictEqual(new Set(topics).size, topics.length);
    assert.ok(topics.length <= 3);
  });

  it('truncates long labels so the card header cannot blow up', () => {
    const long = [
      { key: 'z', label: '这是一个非常非常长的节点标题用来测试截断' },
      { key: 'y', label: 'Y' },
      { key: 'w', label: 'W' },
    ];
    const topics = pickCoreTopics(long, [{ source: 'z', target: 'y' }, { source: 'z', target: 'w' }], 1);
    assert.strictEqual(topics[0], truncateTopic('这是一个非常非常长的节点标题用来测试截断'));
    assert.ok(topics[0].length <= 13);
  });
});

// ── collectLegend ──

describe('collectLegend', () => {
  const colors = { document: '#111', source: '#222', concept: '#333', weird: '#444' };
  const labels = { document: '文档 / 源文件', source: '文档 / 源文件', concept: '概念 / 实体' };

  it('collapses types that share a label into one entry', () => {
    const nodes = [{ nodeType: 'document' }, { nodeType: 'source' }, { nodeType: 'concept' }];
    assert.deepStrictEqual(collectLegend(nodes, colors, labels), [
      { label: '文档 / 源文件', color: '#111' },
      { label: '概念 / 实体', color: '#333' },
    ]);
  });

  it('skips types without a known label or colour', () => {
    assert.deepStrictEqual(collectLegend([{ nodeType: 'weird' }, { nodeType: null }], colors, labels), []);
  });

  it('keeps the order types appear in the graph', () => {
    const nodes = [{ nodeType: 'concept' }, { nodeType: 'document' }];
    assert.deepStrictEqual(
      collectLegend(nodes, colors, labels).map((e) => e.label),
      ['概念 / 实体', '文档 / 源文件'],
    );
  });
});

// ── cardInkFor ──

describe('cardInkFor', () => {
  it('uses dark ink on a light card', () => {
    const ink = cardInkFor('#FAFAFA');
    assert.ok(luminance(ink.title) < 0.3, ink.title);
  });

  it('uses light ink on a dark card', () => {
    const ink = cardInkFor('#0F1117');
    assert.ok(luminance(ink.title) > 0.6, ink.title);
  });

  it('gives muted text less contrast than the title', () => {
    const light = cardInkFor('#FFFFFF');
    assert.ok(luminance(light.muted) > luminance(light.title));
  });
});

// ── computeCardLayout ──

describe('computeCardLayout', () => {
  const natural = computeCardLayout({ graphW: 1200, graphH: 800, aspect: 'natural', hasTopics: true });

  it('keeps the graph at 1:1 in the natural layout (no resampling)', () => {
    assert.ok(natural);
    assert.strictEqual(natural.graphRect.w, 1200);
    assert.strictEqual(natural.graphRect.h, 800);
  });

  it('reserves a header above and a footer below the graph', () => {
    assert.ok(natural);
    assert.ok(natural.titleY < natural.graphRect.y);
    assert.ok(natural.ruleY > natural.graphRect.y + natural.graphRect.h);
    assert.ok(natural.height > natural.graphRect.y + natural.graphRect.h);
  });

  for (const aspect of ['square', 'portrait', 'wide'] as const) {
    it(`honours the ${aspect} aspect ratio`, () => {
      const l = computeCardLayout({ graphW: 1200, graphH: 800, aspect, hasTopics: true });
      assert.ok(l);
      // 圆整误差最多 1px
      assert.ok(Math.abs(l.width / l.height - CARD_ASPECT_RATIO[aspect]) < 0.002, `${l.width}x${l.height}`);
    });
  }

  it('never crops: the drawn graph stays inside its box and keeps its aspect', () => {
    for (const aspect of ['natural', 'square', 'portrait', 'wide'] as const) {
      const l = computeCardLayout({ graphW: 1200, graphH: 2400, aspect, hasTopics: true });
      assert.ok(l);
      assert.ok(l.graphRect.x >= l.graphBox.x - 1, aspect);
      assert.ok(l.graphRect.y >= l.graphBox.y - 1, aspect);
      assert.ok(l.graphRect.x + l.graphRect.w <= l.graphBox.x + l.graphBox.w + 1, aspect);
      assert.ok(l.graphRect.y + l.graphRect.h <= l.graphBox.y + l.graphBox.h + 1, aspect);
      assert.ok(Math.abs(l.graphRect.w / l.graphRect.h - 1200 / 2400) < 0.01, aspect);
    }
  });

  it('never upscales the bitmap', () => {
    const l = computeCardLayout({ graphW: 1200, graphH: 800, aspect: 'wide', hasTopics: false });
    assert.ok(l);
    assert.ok(l.graphRect.w <= 1200);
  });

  it('reclaims the topics line when there are no topics', () => {
    const withTopics = computeCardLayout({ graphW: 1200, graphH: 800, aspect: 'natural', hasTopics: true });
    const without = computeCardLayout({ graphW: 1200, graphH: 800, aspect: 'natural', hasTopics: false });
    assert.ok(withTopics && without);
    assert.ok(without.height < withTopics.height);
  });

  it('refuses to lay out an empty bitmap', () => {
    assert.strictEqual(computeCardLayout({ graphW: 0, graphH: 0, aspect: 'natural', hasTopics: false }), null);
  });

  it('drops the whole header when the info block is off (graph starts at the padding)', () => {
    assert.ok(natural);
    const l = computeCardLayout({
      graphW: 1200,
      graphH: 800,
      aspect: 'natural',
      hasTopics: true,
      includeInfo: false,
    });
    assert.ok(l);
    assert.strictEqual(l.graphBox.y, l.pad);
    assert.strictEqual(l.titleY, 0);
    assert.strictEqual(l.metaY, 0);
    assert.strictEqual(l.topicsY, 0);
    // 图本身不受影响：不裁切、也不放大
    assert.strictEqual(l.graphRect.w, 1200);
    assert.strictEqual(l.graphRect.h, 800);
    assert.ok(l.height < natural.height, `${l.height} vs ${natural.height}`);
  });

  it('still reserves footer room for the watermark when info is off', () => {
    const l = computeCardLayout({ graphW: 1200, graphH: 800, aspect: 'natural', includeInfo: false });
    assert.ok(l);
    assert.ok(l.height > l.graphRect.y + l.graphRect.h);
  });

  it('keeps the fixed aspect with the info block off', () => {
    for (const aspect of ['square', 'portrait', 'wide'] as const) {
      const l = computeCardLayout({ graphW: 1200, graphH: 800, aspect, includeInfo: false });
      assert.ok(l);
      assert.ok(Math.abs(l.width / l.height - CARD_ASPECT_RATIO[aspect]) < 0.002, `${l.width}x${l.height}`);
    }
  });
});

// ── drawCard ──

class FakeCtx {
  font = '';
  fillStyle = '';
  strokeStyle = '';
  textAlign = '';
  textBaseline = '';
  fills: Array<{ color: string; x: number; y: number; w: number; h: number }> = [];
  images: Array<{ x: number; y: number; w: number; h: number }> = [];
  texts: Array<{ text: string; x: number; y: number; color: string; align: string }> = [];
  strokes = 0;
  saved = 0;
  restored = 0;

  save(): void { this.saved += 1; }
  restore(): void { this.restored += 1; }
  measureText(text: string): { width: number } { return { width: text.length * 8 }; }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push({ color: this.fillStyle, x, y, w, h });
  }
  drawImage(_img: unknown, x: number, y: number, w: number, h: number): void {
    this.images.push({ x, y, w, h });
  }
  beginPath(): void {}
  arc(): void {}
  fill(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void { this.strokes += 1; }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, color: this.fillStyle, align: this.textAlign });
  }
}

const INK: CardInk = { title: '#111', muted: '#666', rule: '#eee' };

describe('drawCard', () => {
  const layout = computeCardLayout({ graphW: 1200, graphH: 800, aspect: 'natural', hasTopics: true }) as CardLayout;
  const options = {
    title: '法考刑法',
    meta: '300 个节点 · 900 条连线',
    topics: '核心：共同犯罪 · 主犯 · 从犯',
    legend: [{ label: '文档 / 源文件', color: '#8899AA' }],
    watermark: 'Molio',
    ink: INK,
    bg: '#FAFAFA',
  };

  it('paints the card background before anything else', () => {
    const ctx = new FakeCtx();
    drawCard(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, layout, options);
    assert.deepStrictEqual(ctx.fills[0], { color: '#FAFAFA', x: 0, y: 0, w: layout.width, h: layout.height });
  });

  it('draws the graph exactly into the computed rect', () => {
    const ctx = new FakeCtx();
    drawCard(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, layout, options);
    assert.deepStrictEqual(ctx.images[0], {
      x: layout.graphRect.x,
      y: layout.graphRect.y,
      w: layout.graphRect.w,
      h: layout.graphRect.h,
    });
  });

  it('writes title, meta, topics, legend and watermark', () => {
    const ctx = new FakeCtx();
    drawCard(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, layout, options);
    const texts = ctx.texts.map((t) => t.text);
    for (const expected of ['法考刑法', '300 个节点 · 900 条连线', '核心：共同犯罪 · 主犯 · 从犯', '文档 / 源文件', 'Molio']) {
      assert.ok(texts.includes(expected), `missing "${expected}" in ${JSON.stringify(texts)}`);
    }
  });

  it('right-aligns the watermark in the footer', () => {
    const ctx = new FakeCtx();
    drawCard(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, layout, options);
    const wm = ctx.texts.find((t) => t.text === 'Molio');
    assert.ok(wm);
    assert.strictEqual(wm.align, 'right');
    assert.strictEqual(wm.x, layout.width - layout.pad);
    assert.ok(wm.y > layout.graphRect.y + layout.graphRect.h);
  });

  it('skips the topics line when there is nothing to say', () => {
    const ctx = new FakeCtx();
    drawCard(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, layout, { ...options, topics: '' });
    assert.ok(!ctx.texts.some((t) => t.text.startsWith('核心')));
  });

  it('keeps only the graph and the watermark when the info block is off', () => {
    const bare = computeCardLayout({
      graphW: 1200,
      graphH: 800,
      aspect: 'natural',
      includeInfo: false,
    }) as CardLayout;
    const ctx = new FakeCtx();
    drawCard(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, bare, {
      ...options,
      includeInfo: false,
    });
    // 标题 / 统计 / 核心主题 / 图例全部不画；署名必须在（它不属于「信息」）
    assert.deepStrictEqual(ctx.texts.map((t) => t.text), ['Molio']);
    // 页脚分隔线也只属于信息区
    assert.strictEqual(ctx.strokes, 0);
    assert.strictEqual(ctx.images.length, 1);
  });

  it('restores the context it saved', () => {
    const ctx = new FakeCtx();
    drawCard(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource, layout, options);
    assert.strictEqual(ctx.saved, 1);
    assert.strictEqual(ctx.restored, 1);
  });
});

function luminance(color: string): number {
  const hex = color.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
