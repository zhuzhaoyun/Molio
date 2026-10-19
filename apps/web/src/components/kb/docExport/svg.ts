/**
 * 把一页正文拼成可独立解码的 SVG 字符串。
 *
 * 输出是一个完整 SVG 文档（带 xmlns），因为它会被塞进
 * `<img src="data:image/svg+xml;base64,...">`——SVG 以图片方式加载时是隔离
 * 文档，父页面的样式、字体继承、相对 URL 全部不生效，所以 CSS 必须内嵌、
 * 图片必须先转成 data URL。
 */

import { EXPORT_CLASS, EXPORT_PADDING_X, EXPORT_WIDTH } from './layout.ts';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";

export interface PageFooter {
  page: number;
  total: number;
  watermark: string;
  ink: string;
}

export interface PageSvgOptions {
  /** 已序列化的 `<section class="container">…</section>`。 */
  bodyHtml: string;
  css: string;
  background: string;
  scale: number;
  /** foreignObject 高度（页面坐标，从 0 起算，含顶部内边距）。 */
  bodyHeight: number;
  viewBoxY: number;
  viewBoxHeight: number;
  /**
   * 页面坐标下「正文可见内容」的高度：正常整页 = 上内边距 + 正文高；切片页 =
   * 切片高。`viewBoxY + contentHeight` 是页脚带上沿，页脚前的遮罩从这里盖住
   * 切片溢出到页脚区的正文。
   */
  contentHeight: number;
  footer?: PageFooter;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CSS 里理论上可以出现 `]]>`（字符串字面量），必须拆开再续上 CDATA。 */
function cdata(css: string): string {
  return `<![CDATA[${css.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function buildFooter(footer: PageFooter, bottom: number): string {
  const baseline = bottom - 34;
  const style = `font-family="${FONT_STACK}" font-size="24" fill="${escapeXml(footer.ink)}"`;
  // 水印恒有；页码只在多页时出现——单页导出写 `1 / 1` 只会让读者以为还有下一页。
  const pageNumber =
    footer.total > 1
      ? `<text x="${EXPORT_WIDTH - EXPORT_PADDING_X}" y="${baseline}" text-anchor="end" ${style}>` +
        `${footer.page} / ${footer.total}</text>`
      : '';
  return (
    `<text x="${EXPORT_PADDING_X}" y="${baseline}" ${style}>${escapeXml(footer.watermark)}</text>` +
    pageNumber
  );
}

export function buildPageSvg(options: PageSvgOptions): string {
  const pixelWidth = EXPORT_WIDTH * options.scale;
  // 高度只取整一次：viewBox 与像素高度必须建立在同一个整数上，
  // 否则调用方量出来的小数高度会让缩放倍率与 viewBox 对不上，
  // 光栅化后的 PNG 边缘会多出半像素透明带。
  const pageHeight = Math.max(1, Math.round(options.viewBoxHeight));
  const pixelHeight = pageHeight * options.scale;
  const bodyHeight = Math.max(1, Math.round(options.bodyHeight));
  const footerBottom = options.viewBoxY + pageHeight;
  const footer = options.footer ? buildFooter(options.footer, footerBottom) : '';

  // 切片页的 foreignObject 装的是整块内容，远超当前页的可见高度；不遮住
  // 页脚带的话，切片正文会从页脚文字下面穿过去。遮罩用页面背景色铺满
  // 「内容底 → 页底」这一段，正好把页脚带盖成一块干净底板。
  const maskTop = options.viewBoxY + options.contentHeight;
  const maskHeight = pageHeight - options.contentHeight;
  const mask =
    options.footer && maskHeight > 0
      ? `<rect x="0" y="${maskTop}" width="${EXPORT_WIDTH}" height="${maskHeight}"` +
        ` fill="${escapeXml(options.background)}"/>`
      : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}"` +
      ` viewBox="0 ${options.viewBoxY} ${EXPORT_WIDTH} ${pageHeight}">`,
    `<rect x="0" y="${options.viewBoxY}" width="${EXPORT_WIDTH}" height="${pageHeight}"` +
      ` fill="${escapeXml(options.background)}"/>`,
    `<foreignObject x="0" y="0" width="${EXPORT_WIDTH}" height="${bodyHeight}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" class="${EXPORT_CLASS}">`,
    `<style>${cdata(options.css)}</style>`,
    options.bodyHtml,
    `</div>`,
    `</foreignObject>`,
    mask,
    footer,
    `</svg>`,
  ].join('');
}
