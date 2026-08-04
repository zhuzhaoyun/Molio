import type { PDFDocumentProxy } from './pdfjs-setup';
import type { PDFPageProxy } from 'pdfjs-dist';

export interface PdfTextItem { str: string; transform: number[]; start: number; rawIndex: number; }
export interface PdfPageText { items: PdfTextItem[]; fullText: string; }
export interface PdfMatch { pageNum: number; itemIndex: number; fromInItem: number; toInItem: number; }

/** 构建单页文本索引：fullText 含 hasEOL 换行，item.start 记录字符起点，rawIndex 记录原始 content.items 下标。 */
export async function buildPageText(page: PDFPageProxy): Promise<PdfPageText> {
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  let fullText = '';
  for (const [rawIndex, it] of (content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>).entries()) {
    if (!it.str) continue;
    items.push({ str: it.str, transform: it.transform ?? [1, 0, 0, 1, 0, 0], start: fullText.length, rawIndex });
    fullText += it.str;
    if (it.hasEOL) fullText += '\n';
  }
  return { items, fullText };
}

/** 大小写不敏感子串查找。 */
export function findMatches(fullText: string, query: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const q = query.toLocaleLowerCase();
  if (!q) return out;
  const text = fullText.toLocaleLowerCase();
  let idx = 0;
  for (;;) {
    const found = text.indexOf(q, idx);
    if (found === -1) break;
    out.push({ start: found, end: found + q.length });
    idx = found + q.length;
  }
  return out;
}

/** 把 [start,end) 字符区间映射回其覆盖的 items（可跨 item）。 */
export function mapRangeToItems(
  pageText: PdfPageText, start: number, end: number,
): Array<{ itemIndex: number; fromInItem: number; toInItem: number }> {
  const result: Array<{ itemIndex: number; fromInItem: number; toInItem: number }> = [];
  for (let i = 0; i < pageText.items.length; i++) {
    const item = pageText.items[i];
    const itemStart = item.start;
    const itemEnd = itemStart + item.str.length;
    if (itemEnd <= start || itemStart >= end) continue;
    const from = Math.max(start, itemStart) - itemStart;
    const to = Math.min(end, itemEnd) - itemStart;
    if (to > from) result.push({ itemIndex: item.rawIndex, fromInItem: from, toInItem: to });
  }
  return result;
}

/**
 * 一次匹配（一次 findMatches 命中）跨 item 时，会切成多个 `PdfMatch` 片段。
 * 把这些片段归入一个 `PdfMatchGroup`，使「当前匹配」高亮/计数以「整次匹配」为单位，
 * 而非按片段——避免跨 item 匹配的片段被不同样式拆开。
 */
export interface PdfMatchGroup {
  pageNum: number;
  /** 本次匹配覆盖的 item 片段（跨 item 时多个，通常同一行）。 */
  segments: PdfMatch[];
}

/** 全文档搜索。getText 返回（可缓存的）单页文本。返回按「整次匹配」分组的结果。 */
export async function searchAll(
  doc: PDFDocumentProxy,
  query: string,
  getText: (pageNum: number) => Promise<PdfPageText>,
): Promise<PdfMatchGroup[]> {
  const groups: PdfMatchGroup[] = [];
  const q = query.trim();
  if (!q) return groups;
  for (let n = 1; n <= doc.numPages; n++) {
    const pageText = await getText(n);
    for (const { start, end } of findMatches(pageText.fullText, q)) {
      const segments: PdfMatch[] = [];
      for (const part of mapRangeToItems(pageText, start, end)) {
        segments.push({ pageNum: n, ...part });
      }
      if (segments.length) groups.push({ pageNum: n, segments });
    }
  }
  return groups;
}
