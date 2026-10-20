/**
 * 文档出图的 DOM 流水线：
 *   克隆离屏宿主 → 度量块坐标 → 分页/切片 → 每页序列化进 SVG → canvas 栅格化
 *   → 依次触发下载。
 *
 * 所有「浏览器能力」都集中在这里，布局数学留在 layout.ts、字符串拼装留在
 * svg.ts，便于单测与排障。
 */

import {
  DOWNLOAD_INTERVAL_MS,
  EXPORT_CLASS,
  EXPORT_FOOTER_HEIGHT,
  EXPORT_PADDING_TOP,
  EXPORT_SCALE,
  EXPORT_WIDTH,
  PAGE_BUDGET,
  WATERMARK,
  composeExportCss,
  docExportFileName,
  footerInkFor,
  paginateBlocks,
  rangeHeight,
  sliceVerticalRects,
  type BlockRect,
} from './layout.ts';
import { buildPageSvg, type PageFooter } from './svg.ts';

export class ExportError extends Error {
  readonly code: 'no-output' | 'render-failed';

  // 不用构造函数参数属性：node:test 的 TypeScript 剥离只支持「可擦除语法」，
  // 参数属性会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  constructor(code: 'no-output' | 'render-failed', message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

export interface ExportOptions {
  title: string;
  onProgress?: (done: number, total: number) => void;
}

export interface ExportResult {
  pages: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    // 被等待的 promise 先完成时立刻收掉定时器，避免它拖住事件循环。
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 从元素往上找到第一个非透明背景；全透明时按白底处理。 */
export function effectiveBackground(node: HTMLElement | null): string {
  let current: HTMLElement | null = node;
  while (current) {
    const bg = getComputedStyle(current).backgroundColor;
    if (bg && bg !== 'transparent' && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg)) return bg;
    current = current.parentElement;
  }
  return '#ffffff';
}

/**
 * 收集导出要用的 CSS：
 *   - 页面根版式（宽 / 内边距）
 *   - 从实时 DOM 抓的背景色与正文颜色
 *     （`--foreground` 从未定义，实时页面的颜色是继承来的；SVG 是隔离文档，
 *      继承不到，必须显式写死，否则深色模式导出全是黑字）
 *   - wiki 链接样式（它们住在 knowledge.css，不在 #md-theme 里）
 *   - `#md-theme` 全部主题 CSS + `#output` 顶层/容器内嵌 style 块，统一改写作用域
 */
export function collectExportCss(output: HTMLElement): string {
  // doocs 会把一部分规则（代码块 mac 圆点显隐、`h2 strong` 等）以 `<style>`
  // 直接嵌在 `section.container` 末尾；它们不在 `#md-theme`，也不在 `#output`
  // 顶层，只查 `:scope > style` 会让这些规则漏出导出 SVG。Set 按元素去重：
  // 当前两个选择器（直接子元素 vs 孙元素）不可能重叠，去重是为将来扩选择器
  // 列表时兜底，避免同一个 style 元素被收两次、规则重复膨胀。
  const inlineStyles = new Set<HTMLStyleElement>([
    ...output.querySelectorAll<HTMLStyleElement>(':scope > style'),
    ...output.querySelectorAll<HTMLStyleElement>(':scope > section.container > style'),
  ]);
  // base.css 的代码规则用了三个变量；SVG 隔离文档里它们不会解析，必须抓成
  // 字面量写进导出 CSS。空值（自定义主题没定义）时用 2026-10-19 设计稿的值。
  const rootStyle = getComputedStyle(document.documentElement);
  const cssVar = (name: string, fallback: string) =>
    rootStyle.getPropertyValue(name).trim() || fallback;
  return composeExportCss({
    theme: document.getElementById('md-theme')?.textContent ?? '',
    inline: Array.from(inlineStyles)
      .map((el) => el.textContent ?? '')
      .join('\n'),
    color: getComputedStyle(output).color,
    background: effectiveBackground(output),
    accent: cssVar('--accent', '#3b82f6'),
    code: {
      fontFamily: cssVar('--mono', 'ui-monospace, monospace'),
      background: cssVar('--bg-subtle', '#f4f2ef'),
      color: cssVar('--text', '#1a1917'),
    },
  });
}

/**
 * 把实时 `#output` 克隆到屏幕外（仍在同一文档里，所以主题 CSS 能作用于它）。
 * 用类名而不是 id：同一个页面里不能出现两个 `id="output"`。
 */
export function buildHost(output: HTMLElement, css: string): HTMLElement {
  const host = document.createElement('div');
  host.className = EXPORT_CLASS;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position: fixed',
    'left: -20000px',
    'top: 0',
    'z-index: -1',
    'pointer-events: none',
    'background: transparent',
  ].join(';');

  const style = document.createElement('style');
  style.textContent = css;
  host.appendChild(style);

  // 只克隆内容容器：没有它时 collectBlocks 会抛 `no-output`，整段 innerHTML
  // 兜底既量不准（直接子元素不是分页单位）又会让「空文档」被当成有内容。
  const container = output.querySelector(':scope > section.container');
  if (container) host.appendChild(container.cloneNode(true));

  document.body.appendChild(host);
  return host;
}

/**
 * 等待图片解码与字体就绪。离屏宿主里的图默认 `lazy`，永远不会进入视口，
 * 必须改 `eager` 才会开始加载；断图 decode 会 reject，吞掉即可。
 */
export async function waitForAssets(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  for (const img of images) img.loading = 'eager';
  await Promise.all(images.map((img) => withTimeout(img.decode().catch(() => undefined), 10_000)));
  try {
    await withTimeout(document.fonts.ready, 5_000);
  } catch {
    // 只用系统字体，等不到也照常导出
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 把同源图片抓成 data URL。SVG 以 `<img>` 方式加载时禁止外部子资源，
 * 不内联就是一张张空白框。抓取失败的图保持原样（断图不阻断整篇导出）。
 */
export async function inlineImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      if (!src || src.startsWith('data:')) return;
      try {
        // 没有超时的话，一个挂起的请求会把导出按钮永久锁在 disabled——
        // 用户除了刷新页面没有别的出路。
        const res = await fetch(src, {
          credentials: 'same-origin',
          signal: AbortSignal.timeout(10_000),
        });
        // 非 2xx 也按失败处理：保持原 src，并留下一条可排查的 warn。
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        img.src = await blobToDataUrl(blob);
        img.removeAttribute('srcset');
      } catch (error) {
        // 断图 / 跨域 / 超时：保留原 src，栅格化时自然缺失
        console.warn('文档出图：图片内联失败', src, error);
      }
    }),
  );
}

/** 不占版面的元素：元数据标签永不渲染；display:none 节点同样如此。 */
const NON_VISUAL_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'TEMPLATE']);

/**
 * 这类元素一旦混进块列表，度量就报废：它们的 getBoundingClientRect 是
 * 视口原点的 (0,0) 零矩形，相对容器顶边量出来是负的 top——排最后的
 * 话 `rangeHeight` 直接算出负高度，整页被压成一张空图（真实案例：doocs
 * 把代码块语言标签样式以 `<style>` 内嵌在 section.container 末尾）。
 */
function occupiesLayout(el: Element): boolean {
  if (NON_VISUAL_TAGS.has(el.tagName)) return false;
  return getComputedStyle(el).display !== 'none';
}

/**
 * 分页单位是内容容器的直接子元素——doocs 把全文包在
 * `<section class="container">` 里，直接取 `#output` 子元素只会得到 1 个块。
 */
export function collectBlocks(host: HTMLElement): {
  container: HTMLElement;
  blocks: HTMLElement[];
} {
  const container = host.querySelector(':scope > section.container') as HTMLElement | null;
  if (!container) throw new ExportError('no-output', '找不到文档内容容器');
  return {
    container,
    blocks: Array.from(container.children).filter(occupiesLayout) as HTMLElement[],
  };
}

/** 块坐标相对容器顶边（容器本身已经是正文的起点）。 */
export function measureBlocks(container: HTMLElement, blocks: HTMLElement[]): BlockRect[] {
  const base = container.getBoundingClientRect().top;
  return blocks.map((el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top - base, height: rect.height };
  });
}

/**
 * 序列化一页正文。必须保留外层 `section.container`——主题 CSS 把标题规则
 * 写成了 `#output section h1`，丢了这层包装标题样式整页失效。
 */
export function serializePageBody(
  container: HTMLElement,
  blocks: HTMLElement[],
  from: number,
  to: number,
): string {
  const clone = container.cloneNode(false) as HTMLElement;
  for (let i = from; i < to; i += 1) {
    clone.appendChild(blocks[i].cloneNode(true));
  }
  return new XMLSerializer().serializeToString(clone);
}

/** 分块转 base64：一次 spread 整个大数组会爆调用栈。 */
export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function drawSvgToCanvas(
  svg: string,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.src = `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportError('render-failed', '浏览器没有提供 2d canvas');
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ExportError('render-failed', 'canvas.toBlob 返回空'));
    }, 'image/png');
  });
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 下载是异步的：立刻 revoke 在部分浏览器会让文件变成 0 字节
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 一页的几何规划（不含 DOM 序列化结果），可脱离浏览器单测。 */
export interface PagePlan {
  /** 正文块索引区间 `[from, to)`。 */
  from: number;
  to: number;
  /** foreignObject 高度（页面坐标，从 0 起算，含顶部内边距）。 */
  bodyHeight: number;
  viewBoxY: number;
  viewBoxHeight: number;
  /** 页面坐标下正文可见高度；页脚带上沿 = viewBoxY + contentHeight。 */
  contentHeight: number;
}

/**
 * 把测量好的块坐标规划成页。纯函数：不碰 DOM，分页与切片的坐标错误
 * （例如多算了一次块在原文档中的偏移）必须靠单测守住。
 */
export function planPages(rects: BlockRect[], budget: number = PAGE_BUDGET): PagePlan[] {
  const pages: PagePlan[] = [];
  for (const [from, to] of paginateBlocks(rects, budget)) {
    const height = rangeHeight(rects, from, to);

    if (height <= budget) {
      pages.push({
        from,
        to,
        bodyHeight: EXPORT_PADDING_TOP + height,
        viewBoxY: 0,
        viewBoxHeight: EXPORT_PADDING_TOP + height + EXPORT_FOOTER_HEIGHT,
        contentHeight: EXPORT_PADDING_TOP + height,
      });
      continue;
    }

    // 单块高于一页：整页按固定高度切开。这一块的 `bodyHtml` 只有它自己
    // （paginateBlocks 让超高块独占一页），重新挂到克隆容器顶部后渲染在
    // 页面坐标 `paddingTop` 处；所以切片坐标只能加 `paddingTop`，绝不能
    // 再加它在原文档里的 `top`——那会让非首块的导出整体下移、越切越空。
    for (const slice of sliceVerticalRects(height, budget)) {
      pages.push({
        from,
        to,
        bodyHeight: EXPORT_PADDING_TOP + height,
        viewBoxY: EXPORT_PADDING_TOP + slice.top,
        // 切片页同样保留页脚带（署名 + 页码），页脚带上沿刚好是切片底边。
        viewBoxHeight: slice.height + EXPORT_FOOTER_HEIGHT,
        contentHeight: slice.height,
      });
    }
  }
  return pages;
}

interface RasterPage {
  bodyHtml: string;
  bodyHeight: number;
  viewBoxY: number;
  viewBoxHeight: number;
  contentHeight: number;
}

/**
 * 一页的栅格化。先试 2 倍；解码失败或 toBlob 返回空时降 1 倍重试。
 * 某些平台的 canvas 尺寸上限会把 2 倍的大页打回来，1 倍是最后的可用路径。
 */
async function rasterizePage(
  page: RasterPage,
  context: { css: string; background: string; footer?: PageFooter },
): Promise<Blob> {
  let lastError: unknown;
  for (const scale of [EXPORT_SCALE, 1]) {
    try {
      const svg = buildPageSvg({
        bodyHtml: page.bodyHtml,
        css: context.css,
        background: context.background,
        scale,
        bodyHeight: page.bodyHeight,
        viewBoxY: page.viewBoxY,
        viewBoxHeight: page.viewBoxHeight,
        contentHeight: page.contentHeight,
        footer: context.footer,
      });
      // 高度必须与 buildPageSvg 内部一致：先对 viewBox 高度取整，再乘倍率。
      // 反过来（round(vh * scale)）会在小数高度上得到 ±1px 的纵横比失配。
      const canvas = await drawSvgToCanvas(
        svg,
        EXPORT_WIDTH * scale,
        Math.max(1, Math.round(page.viewBoxHeight)) * scale,
      );
      return await canvasToPng(canvas);
    } catch (error) {
      lastError = error;
      console.warn(`文档出图在 ${scale} 倍下失败，降级重试`, error);
    }
  }
  throw lastError instanceof ExportError
    ? lastError
    : new ExportError('render-failed', String(lastError));
}

export async function exportDocument(
  output: HTMLElement,
  options: ExportOptions,
): Promise<ExportResult> {
  const css = collectExportCss(output);
  const background = effectiveBackground(output);
  const ink = footerInkFor(background);
  const host = buildHost(output, css);

  try {
    await inlineImages(host);
    await waitForAssets(host);

    const { container, blocks } = collectBlocks(host);
    if (blocks.length === 0) throw new ExportError('no-output', '文档没有可导出的内容');
    const rects = measureBlocks(container, blocks);

    // 先把所有页规划并序列化出来，才能知道总页数、把 `页码 / 总页数` 写进每一页。
    // 超高块会切成多页：同一 `[from, to)` 只序列化一次、切片复用同一份字符串，
    // 否则一张很长的表格/代码块会随切片数成倍放大克隆与内存开销。
    const bodyHtmlByRange = new Map<string, string>();
    const pages: RasterPage[] = planPages(rects, PAGE_BUDGET).map((plan) => {
      const key = `${plan.from}:${plan.to}`;
      let bodyHtml = bodyHtmlByRange.get(key);
      if (bodyHtml === undefined) {
        bodyHtml = serializePageBody(container, blocks, plan.from, plan.to);
        bodyHtmlByRange.set(key, bodyHtml);
      }
      return {
        bodyHtml,
        bodyHeight: plan.bodyHeight,
        viewBoxY: plan.viewBoxY,
        viewBoxHeight: plan.viewBoxHeight,
        contentHeight: plan.contentHeight,
      };
    });

    const total = pages.length;
    // 所有页共用同一个 `now`：一篇文章的多张图落在同一分钟里，按文件名排序
    // 就是阅读顺序（`-1`、`-2` …），不会因为跨分钟而乱序。
    const now = new Date();

    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      // 每一页都有页脚（署名恒有；页码由 buildFooter 按 total 决定是否渲染）：
      // 切片页也不例外，否则长文档中间几张会突然没有署名和页码。
      const footer = { page: i + 1, total, watermark: WATERMARK, ink };
      const blob = await rasterizePage(page, { css, background, footer });
      triggerDownload(blob, docExportFileName(options.title, now, i + 1, total));
      options.onProgress?.(i + 1, total);
      if (i < pages.length - 1) await sleep(DOWNLOAD_INTERVAL_MS);
    }

    return { pages: total };
  } finally {
    host.remove();
  }
}
