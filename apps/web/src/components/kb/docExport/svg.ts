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
  /** 只有正常整页带页脚；超大块的切片不带。 */
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
  return (
    `<text x="${EXPORT_PADDING_X}" y="${baseline}" ${style}>${escapeXml(footer.watermark)}</text>` +
    `<text x="${EXPORT_WIDTH - EXPORT_PADDING_X}" y="${baseline}" text-anchor="end" ${style}>` +
    `${footer.page} / ${footer.total}</text>`
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
    footer,
    `</svg>`,
  ].join('');
}
