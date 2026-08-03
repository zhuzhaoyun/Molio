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

/** 全文档搜索。getText 返回（可缓存的）单页文本。 */
export async function searchAll(
  doc: PDFDocumentProxy,
  query: string,
  getText: (pageNum: number) => Promise<PdfPageText>,
): Promise<PdfMatch[]> {
  const matches: PdfMatch[] = [];
  const q = query.trim();
  if (!q) return matches;
  for (let n = 1; n <= doc.numPages; n++) {
    const pageText = await getText(n);
    for (const { start, end } of findMatches(pageText.fullText, q)) {
      for (const part of mapRangeToItems(pageText, start, end)) {
        matches.push({ pageNum: n, ...part });
      }
    }
  }
  return matches;
}
