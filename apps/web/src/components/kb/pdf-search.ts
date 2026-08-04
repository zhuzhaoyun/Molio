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

/** 转义正则特殊字符。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 大小写不敏感子串查找。
 * 用正则 `i` 标志在**原串**上匹配，返回原串下标——避免 `toLocaleLowerCase()` 改变字符串长度
 * （如 `İ`→`i̇`）导致小写化后的下标与原串错位（表现为匹配整体偏移 1 字符）。
 */
export function findMatches(fullText: string, query: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const q = query.trim();
  if (!q) return out;
  let re: RegExp;
  try {
    re = new RegExp(escapeRegExp(q), 'gi');
  } catch {
    return out;
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullText)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++; // 空匹配保护，防死循环
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
