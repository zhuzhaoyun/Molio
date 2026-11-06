/**
 * 图谱「出图卡片」的纯计算部分：核心主题、图例、墨色、版式几何与绘制。
 *
 * 为什么要卡片而不是直接给一张图：截图给的是像素，我们能给的是**引擎知道的东西** ——
 * 库名、节点/连线数、度数最高的几个节点（这个库在研究什么）、节点颜色代表什么。
 * 发送方拿到的是一张「能自己说明白」的图，接收方不用猜颜色含义，也不用追问出处。
 *
 * 分工：引擎（pixiGraphEngine）只产出图的位图；这里负责把位图排进卡片。
 * 全部是可算逻辑，node:test 覆盖；真实合成本身是一次性 canvas 调用，靠 E2E 兜底。
 */

const CARD_FONT = 'Inter, "PingFang SC", -apple-system, sans-serif';

/** 核心主题最多几个 —— 标题卡第二行放得下，也不至于让图变成排行榜。 */
const MAX_TOPICS = 3;
/** 单个主题名的字数上限（含省略号），防止长标题把版式撑坏。 */
const TOPIC_MAX_CHARS = 12;
/** 图例最多几档（三种颜色桶 + 余量）。 */
const MAX_LEGEND = 3;

export type CardAspect = 'natural' | 'square' | 'portrait' | 'wide';

/** 固定版式的宽高比。`natural` 不在表里：它由图的原始比例决定。 */
export const CARD_ASPECT_RATIO: Record<Exclude<CardAspect, 'natural'>, number> = {
  square: 1,
  portrait: 4 / 5,
  wide: 16 / 9,
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TopicNode {
  key: string;
  label: string;
  dead?: boolean;
}

export interface TopicEdge {
  source: string;
  target: string;
}

/**
 * 核心主题：按**可见图**里的度数取前 N（双向都算，自环不算）。
 *
 * 只用图里真实存在、且不是死链占位的节点 —— 死链是「指向不存在的笔记」的占位符，
 * 把它写成「这个库的核心主题」是错的。没有连线就返回空：孤立笔记没有「核心」可言。
 */
export function pickCoreTopics(nodes: TopicNode[], edges: TopicEdge[], max = MAX_TOPICS): string[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const degree = new Map<string, number>();

  const bump = (key: string) => degree.set(key, (degree.get(key) ?? 0) + 1);
  for (const e of edges) {
    if (e.source === e.target) continue;
    const s = byKey.get(e.source);
    const t = byKey.get(e.target);
    if (s && !s.dead) bump(s.key);
    if (t && !t.dead) bump(t.key);
  }

  const ranked = nodes
    .filter((n) => !n.dead && n.label.trim().length > 0 && (degree.get(n.key) ?? 0) > 0)
    .sort((a, b) => (degree.get(b.key) ?? 0) - (degree.get(a.key) ?? 0) || a.label.localeCompare(b.label));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of ranked) {
    const label = truncateTopic(n.label);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/** 标题卡里的主题名截断：超过上限留一个省略号。 */
export function truncateTopic(label: string, maxChars = TOPIC_MAX_CHARS): string {
  const text = label.trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * 图例：只列图里**真实出现**的类型，按首次出现顺序。
 * 多个类型共享同一个展示名（document/source/wiki 都是「文档 / 源文件」）时合并成一条 ——
 * 否则图例会重复三遍同一种颜色，接收方更糊涂。
 */
export function collectLegend(
  nodes: Array<{ nodeType?: string | null }>,
  colorFor: Record<string, string>,
  labelFor: Record<string, string>,
  max = MAX_LEGEND,
): Array<{ label: string; color: string }> {
  const out: Array<{ label: string; color: string }> = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const type = n.nodeType;
    if (!type) continue;
    const label = labelFor[type];
    const color = colorFor[type];
    if (!label || !color || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, color });
    if (out.length >= max) break;
  }
  return out;
}

export interface CardInk {
  title: string;
  muted: string;
  rule: string;
}

const INK_ON_LIGHT_CARD: CardInk = {
  title: '#1F2328',
  muted: '#6B6B6B',
  rule: 'rgba(0,0,0,0.10)',
};
const INK_ON_DARK_CARD: CardInk = {
  title: '#E5E7EB',
  muted: '#9CA3AF',
  rule: 'rgba(255,255,255,0.14)',
};

/** 卡片墨色跟着图底色走 —— 浅底用深墨、深底用浅墨，和画布主题一致。 */
export function cardInkFor(background: string): CardInk {
  const rgb = parseHexColor(background);
  if (!rgb) return INK_ON_LIGHT_CARD;
  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? INK_ON_LIGHT_CARD : INK_ON_DARK_CARD;
}

export interface CardLayoutInput {
  graphW: number;
  graphH: number;
  aspect: CardAspect;
  /** 是否有核心主题行：没有时把头部的空间还给图，不留一条空行。 */
  hasTopics?: boolean;
  /**
   * 是否附带信息块（标题 / 统计 / 核心主题 / 图例）。关掉时整块头部让给图，
   * 只留署名 —— 有人就是想要一张干净的图。默认开。
   */
  includeInfo?: boolean;
}

export interface CardLayout {
  width: number;
  height: number;
  pad: number;
  titleY: number;
  titleFont: number;
  metaY: number;
  smallFont: number;
  topicsY: number;
  graphBox: Rect;
  graphRect: Rect;
  ruleY: number;
  legendY: number;
  legendFont: number;
  legendDot: number;
}

/**
 * 卡片版式。所有尺寸从**图的宽**推出来，所以同一张图在任何倍率下版式一致。
 *
 * 固定版式（1:1 / 4:5 / 16:9）是 **contain 不裁切**：图谱裁掉一块就没有意义了，
 * 宁可留白。图也**绝不上采样**（放大位图只会变糊）。
 */
export function computeCardLayout(input: CardLayoutInput): CardLayout | null {
  const graphW = Math.round(input.graphW);
  const graphH = Math.round(input.graphH);
  if (!(graphW > 0) || !(graphH > 0)) return null;
  const hasTopics = input.hasTopics ?? false;
  const includeInfo = input.includeInfo ?? true;

  const pad = Math.max(12, Math.round(graphW * 0.045));
  const width = graphW + pad * 2;
  const titleFont = clamp(Math.round(width * 0.034), 16, 72);
  const smallFont = clamp(Math.round(width * 0.017), 10, 34);
  const legendFont = clamp(Math.round(width * 0.015), 9, 30);
  const legendDot = Math.max(4, Math.round(legendFont * 0.7));

  // 信息块关掉时头部只剩上下留白：位置字段置 0，调用方按 0 也无法误画。
  const titleY = includeInfo ? pad + titleFont : 0;
  const metaY = includeInfo ? titleY + Math.round(titleFont * 0.45) + smallFont : 0;
  const topicsY = includeInfo && hasTopics ? metaY + Math.round(smallFont * 1.6) : 0;
  const headerBottom = includeInfo
    ? (hasTopics ? topicsY : metaY) + Math.round(smallFont * 0.9) + Math.round(pad * 0.4)
    : pad;
  // 页脚带的预留必须覆盖它的全部消费：「图底 → 分隔线」空隙 + 图例行自身
  // + 行下到卡底的呼吸空间。漏掉空隙时（2026-10-24 真实案例）基线按
  // ruleY + 0.55×footerH 定位后正好把预留花光，legendFont 一被 clamp 到
  // 上限（导出位图长边 ≥ ~2000 就命中）基线就沉到卡底之下，图例和署名
  // 被裁掉近半。三项分列后可证任何尺寸都安全：基线下的字身 ≈ 0.61×f，
  // 而图例行自身留了 2.2×f，永远盖得住。
  const footerGap = Math.round(pad * 0.35);
  const legendRowH = Math.round(legendFont * 2.2);
  const footerH = footerGap + legendRowH + Math.round(pad * 0.3);

  const naturalH = headerBottom + graphH + footerH;
  const height =
    input.aspect === 'natural'
      ? naturalH
      : Math.max(
          Math.round(width / CARD_ASPECT_RATIO[input.aspect]),
          // 极端比例下也别把图挤成一条 —— 允许比例略微走样，好过看不见内容
          headerBottom + footerH + 48,
        );

  const boxW = width - pad * 2;
  const boxH = height - headerBottom - footerH;
  const scale = Math.min(boxW / graphW, boxH / graphH, 1);
  const drawW = Math.max(1, Math.round(graphW * scale));
  const drawH = Math.max(1, Math.round(graphH * scale));

  const graphBox: Rect = { x: pad, y: headerBottom, w: boxW, h: boxH };
  const graphRect: Rect = {
    x: Math.round(pad + (boxW - drawW) / 2),
    y: Math.round(headerBottom + (boxH - drawH) / 2),
    w: drawW,
    h: drawH,
  };

  const ruleY = graphBox.y + graphBox.h + footerGap;
  // 图例在「分隔线 → 卡底」的子带内取中，不能按整个 footerH 取中——
  // 那会把空隙二次摊进行位置，正是溢出的来源。
  const legendY = ruleY + Math.round(legendRowH * 0.55);

  return {
    width,
    height,
    pad,
    titleY,
    titleFont,
    metaY,
    smallFont,
    topicsY,
    graphBox,
    graphRect,
    ruleY,
    legendY,
    legendFont,
    legendDot,
  };
}

export interface CardDrawOptions {
  /** 库名 —— 默认就是知识库的名字，空则不出这一行。 */
  title: string;
  /** 统计行：节点 / 连线数，必须与图面一致（取筛选后的数）。 */
  meta: string;
  /** 核心主题行，已由调用方拼好；空串则不出这一行、也不占位置。 */
  topics: string;
  legend: Array<{ label: string; color: string }>;
  watermark: string;
  ink: CardInk;
  bg: string;
  /** 是否画信息块（标题 / 统计 / 核心主题 / 图例）。署名不受影响。默认开。 */
  includeInfo?: boolean;
}

/** 把图画进卡片。只接 2D 上下文，不碰 DOM —— 因此可以在 node:test 里用假上下文断言调用。 */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  graph: CanvasImageSource,
  layout: CardLayout,
  opts: CardDrawOptions,
): void {
  const includeInfo = opts.includeInfo ?? true;

  ctx.save();

  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  ctx.drawImage(graph, layout.graphRect.x, layout.graphRect.y, layout.graphRect.w, layout.graphRect.h);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const textWidth = layout.width - layout.pad * 2;

  if (includeInfo) {
    if (opts.title) {
      ctx.font = `600 ${layout.titleFont}px ${CARD_FONT}`;
      ctx.fillStyle = opts.ink.title;
      ctx.fillText(opts.title, layout.pad, layout.titleY, textWidth);
    }

    ctx.font = `${layout.smallFont}px ${CARD_FONT}`;
    ctx.fillStyle = opts.ink.muted;
    if (opts.meta) ctx.fillText(opts.meta, layout.pad, layout.metaY, textWidth);
    if (opts.topics) ctx.fillText(opts.topics, layout.pad, layout.topicsY, textWidth);

    // 页脚分隔线：把图与「出处信息」分开，观感上像一张卡片而不是一张截图
    ctx.strokeStyle = opts.ink.rule;
    ctx.beginPath();
    ctx.moveTo(layout.pad, layout.ruleY);
    ctx.lineTo(layout.width - layout.pad, layout.ruleY);
    ctx.stroke();
  }

  // 署名始终画（不属于可关的信息块）；图例则留出署名宽度，
  // 放不下就少放一项 —— 宁可少一项，也不和署名叠在一起。
  ctx.font = `${layout.legendFont}px ${CARD_FONT}`;
  const right = layout.width - layout.pad;
  const textBaselineY = layout.legendY + Math.round(layout.legendFont * 0.36);
  if (includeInfo) {
    const watermarkW = ctx.measureText(opts.watermark).width;
    const limit = right - watermarkW - layout.legendFont;
    let x = layout.pad;
    for (const item of opts.legend) {
      const labelW = ctx.measureText(item.label).width;
      if (x + layout.legendDot + layout.legendFont * 0.5 + labelW > limit) break;
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(x + layout.legendDot / 2, layout.legendY, layout.legendDot / 2, 0, Math.PI * 2);
      ctx.fill();
      x += layout.legendDot + layout.legendFont * 0.5;
      ctx.fillStyle = opts.ink.muted;
      ctx.fillText(item.label, x, textBaselineY);
      x += labelW + layout.legendFont * 1.3;
    }
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = opts.ink.muted;
  ctx.fillText(opts.watermark, right, textBaselineY);

  ctx.restore();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}
