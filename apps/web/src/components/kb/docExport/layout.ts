/**
 * 文档出图的纯计算层：常量、CSS 作用域改写、分页、文件名、页脚颜色。
 *
 * 这一层不碰 DOM，全部可在 node:test 里直接跑——分页错一位就是多出一张
 * 空白页或截断一段正文，必须靠单测守住。
 */

import { slugifyTitle } from '../../../utils/exportFileName.ts';
import { HEADER_CLASS } from './header.ts';

export const EXPORT_WIDTH = 1080;
export const EXPORT_PADDING_X = 64;
export const EXPORT_PADDING_TOP = 64;
export const EXPORT_FOOTER_HEIGHT = 88;
export const MAX_PAGE_HEIGHT = 7400;
export const EXPORT_SCALE = 2;
export const DOWNLOAD_INTERVAL_MS = 300;
export const WATERMARK = 'Molio';
export const EXPORT_CLASS = 'molio-doc-export';
export const EXPORT_SCOPE = `.${EXPORT_CLASS}`;
export const CONTENT_WIDTH = EXPORT_WIDTH - EXPORT_PADDING_X * 2;
export const PAGE_BUDGET = MAX_PAGE_HEIGHT - EXPORT_PADDING_TOP - EXPORT_FOOTER_HEIGHT;

/** 导出版式预设。`long` = 一期的长图，`card34` = 3:4 竖卡（小红书主流比例）。 */
export type ExportPreset = 'long' | 'card34';

export interface PresetParams {
  /** 固定页高；`long` 只有上限（末页按内容自适应），`card34` 每页都填满。 */
  pageHeight: number;
  /** 一页能放多少正文（已扣掉顶部内边距与页脚带）。 */
  pageBudget: number;
}

/**
 * 版式参数。`long` 返回一期常量（默认行为永不变）；`card34` 是 3:4 竖卡——
 * 页高 = 宽 × 4/3，正好吃满一期「遮罩补底 + 页脚带」的切片几何，无需新机制。
 */
export function exportPresetParams(preset: ExportPreset = 'long'): PresetParams {
  if (preset === 'card34') {
    const pageHeight = Math.round((EXPORT_WIDTH * 4) / 3);
    return {
      pageHeight,
      pageBudget: pageHeight - EXPORT_PADDING_TOP - EXPORT_FOOTER_HEIGHT,
    };
  }
  return { pageHeight: MAX_PAGE_HEIGHT, pageBudget: PAGE_BUDGET };
}

/** 测量宿主与 SVG 页面根共用的版式。两边必须一字不差，否则量的和画的对不上。 */
export const EXPORT_ROOT_CSS =
  `${EXPORT_SCOPE} { box-sizing: border-box; width: ${EXPORT_WIDTH}px;` +
  ` padding: ${EXPORT_PADDING_TOP}px ${EXPORT_PADDING_X}px 0; }`;

/**
 * 把主题 CSS 从「只作用于 #output」改写成「只作用于导出根」。
 *
 * `:root` 也要改写：doocs 的 CSS 变量定义在 `:root` 上，而 SVG 文档里没有
 * html 根元素，变量会全部失效，正文直接掉回浏览器默认字号/字体。
 */
export function rewriteScope(css: string, scope: string = EXPORT_SCOPE): string {
  return css.replace(/#output(?![\w-])/g, scope).replace(/:root(?![\w-])/g, scope);
}

export interface ExportCssParts {
  /** `#md-theme` 的全部内容。 */
  theme: string;
  /** `#output` 顶层 `<style>` 块的内容。 */
  inline: string;
  /** 实时 DOM 里 `#output` 的 computed color。 */
  color: string;
  /** 实时 DOM 里第一个不透明祖先的背景色。 */
  background: string;
  /** 应用主题色（wiki 链接边框用）。 */
  accent: string;
  /** 应用 `base.css` 里影响代码排版的变量解析值。 */
  code: { fontFamily: string; background: string; color: string };
}

/**
 * 组装导出 CSS。
 *
 * `color` / `background` 必须由调用方从实时 DOM 的 computed style 取：doocs
 * 主题里的 `hsl(var(--foreground))` 是无效值（`--foreground` 从未定义），实时
 * 页面的正文颜色其实是继承来的；SVG 作为图片是隔离文档，继承不到，不显式
 * 写死就会在深色模式下导出黑字。
 */
export function composeExportCss(parts: ExportCssParts): string {
  // 以下两条规则复制自 apps/web/src/styles/base.css（`* { box-sizing }` 与
  // `code { … }`）。离屏测量宿主长在应用文档里，天然吃得到 base.css；导出的
  // SVG 是隔离文档，只会拿到这里。两边不同级联时量出来的高度会比画出来的矮
  // （代码块尤其明显：少一条 `font-size: 0.92em` 就矮 8.7%），分页随后按错的
  // 高度裁切，正文底部被静默丢掉。**改 base.css 这两条时必须同步改这里。**
  // 选择器必须带 `.molio-doc-export` 作用域：同一份 CSS 也以 <style> 注入
  // 实时宿主，裸规则会漏到整个应用。主题自己的 `.codespan` /
  // `pre.code__pre > code` 选择器优先级仍高于这里的元素规则，两个世界一致。
  // base.css 里 button/input/textarea/select 的规则尚未镜像：Markdown 里内嵌
  // 原始表单控件属于极少数场景，导出会与预览不一致；需要时按同一方式补。
  const compat = [
    `${EXPORT_SCOPE} { color: ${parts.color}; background: ${parts.background}; }`,
    `${EXPORT_SCOPE} * { box-sizing: border-box; }`,
    `${EXPORT_SCOPE} code { font-family: ${parts.code.fontFamily};` +
      ` background: ${parts.code.background}; color: ${parts.code.color};` +
      ` padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }`,
    `${EXPORT_SCOPE} a.kb-wiki-link { cursor: pointer; color: ${parts.accent};` +
      ` text-decoration: none; border-bottom: 1px dashed ${parts.accent}; }`,
  ].join('\n');
  // 导出专属的有意偏离：预览里长代码行可以横向滚动，静态图里滚不了，
  // 保持 nowrap 等于把行尾静默裁掉。放在主题 CSS 之后，才能压过主题同
  // 优先级的 `white-space: nowrap`。
  const deviations = [
    `${EXPORT_SCOPE} pre.code__pre > code,`,
    `${EXPORT_SCOPE} .hljs.code__pre > code {`,
    '  white-space: pre-wrap;',
    '  overflow-wrap: anywhere;',
    '}',
  ].join('\n');
  // 头卡（标题 + 元信息 + 标签）规则无条件输出：头卡元素只在传入
  // `options.header` 时才存在，规则空跑无害；这样 composeExportCss 不需要
  // 知道「头卡开没开」，少一处分支就少一处「开了但没样式」的漏配。
  // 字号用 em（跟随主题基准字号，跨主题自适应）。
  // 强调色优先用 doocs 主题自己的 --md-primary-color（用户在样式面板选的
  // 主题色，与正文标题下划线同源），主题没定义时回退应用 accent。var() 在
  // 计算值阶段解析，不受这条规则先于主题 CSS 输出的影响（变量定义就在
  // 主题 CSS 的 :root 上，rewriteScope 后落在导出根）。
  const primary = `var(--md-primary-color, ${parts.accent})`;
  const headerCss = [
    `${EXPORT_SCOPE} .${HEADER_CLASS} { margin: 0 0 1.5em; padding-bottom: 1em;` +
      ` border-bottom: 2px solid ${primary}; }`,
    `${EXPORT_SCOPE} .${HEADER_CLASS}__title { font-size: 2em; font-weight: 700;` +
      ` line-height: 1.35; margin: 0; }`,
    `${EXPORT_SCOPE} .${HEADER_CLASS}__meta { margin-top: 0.6em; font-size: 0.85em;` +
      ` color: ${footerInkFor(parts.background)}; }`,
    `${EXPORT_SCOPE} .${HEADER_CLASS}__tags { margin-top: 0.8em; display: flex;` +
      ` flex-wrap: wrap; gap: 0.5em; }`,
    `${EXPORT_SCOPE} .${HEADER_CLASS}__tags span { font-size: 0.8em;` +
      ` padding: 0.15em 0.8em; border: 1px solid ${primary}; border-radius: 999px; }`,
    `${EXPORT_SCOPE} .${HEADER_CLASS}__more { color: ${footerInkFor(parts.background)};` +
      ` border-color: ${footerInkFor(parts.background)}; }`,
  ].join('\n');
  return [
    EXPORT_ROOT_CSS,
    compat,
    headerCss,
    rewriteScope(parts.theme),
    rewriteScope(parts.inline),
    deviations,
  ].join('\n');
}

export interface BlockRect {
  top: number;
  height: number;
}

/** 一段连续块从第一个块的顶边到最后一个块的底边（含块间外边距）。 */
export function rangeHeight(blocks: BlockRect[], from: number, to: number): number {
  const first = blocks[from];
  const last = blocks[to - 1];
  if (!first || !last) return 0;
  return last.top + last.height - first.top;
}

/**
 * 按高度贪心分页，返回 `[from, to)` 索引区间。
 *
 * 单块本身高于预算时独占一页——由调用方判断「这页超高」再切片，绝不丢弃。
 */
export function paginateBlocks(
  blocks: BlockRect[],
  budget: number = PAGE_BUDGET,
): Array<[number, number]> {
  const pages: Array<[number, number]> = [];
  let start = 0;
  while (start < blocks.length) {
    const pageTop = blocks[start].top;
    let end = start + 1;
    while (end < blocks.length && blocks[end].top + blocks[end].height - pageTop <= budget) {
      end += 1;
    }
    pages.push([start, end]);
    start = end;
  }
  return pages;
}

export interface SliceRect {
  top: number;
  height: number;
}

/** 把一个超高块按固定高度纵向切片；向上取整保证最后一行不被裁掉。 */
export function sliceVerticalRects(
  totalHeight: number,
  maxHeight: number = PAGE_BUDGET,
): SliceRect[] {
  const total = Math.max(1, Math.ceil(totalHeight));
  const slices: SliceRect[] = [];
  for (let top = 0; top < total; top += maxHeight) {
    slices.push({ top, height: Math.min(maxHeight, total - top) });
  }
  return slices;
}

function parseRgb(color: string): [number, number, number] | null {
  const value = color.trim();
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1] as string;
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .slice(0, 3)
        .split('')
        .map((ch) => ch + ch)
        .join('');
    }
    if (digits.length < 6) return null;
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ];
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** 页脚文字颜色：亮底用半透明黑，暗底用半透明白，解析不了给中性灰。 */
export function footerInkFor(background: string): string {
  const rgb = parseRgb(background);
  if (!rgb) return '#8a8a8a';
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return luminance > 0.55 ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.55)';
}

/**
 * 导出文件名：`molio-doc-<标题>-20261019-0905[-1].png`。
 *
 * 多页时页码从 1 开始；单页不带页码（下载目录里多出来的 `-1` 只会让人以为
 * 还有第二张）。
 */
export function docExportFileName(
  title: string,
  date: Date,
  page?: number,
  total?: number,
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hm = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slug = slugifyTitle(title);
  const stem = slug ? `molio-doc-${slug}` : 'molio-doc';
  const pageSuffix = page && total && total > 1 ? `-${page}` : '';
  return `${stem}-${ymd}-${hm}${pageSuffix}.png`;
}
