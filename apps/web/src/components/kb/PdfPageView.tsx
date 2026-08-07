import { forwardRef, useCallback, useEffect, useRef } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from './pdfjs-setup';

export interface PdfSearchHit {
  itemIndex: number;
  fromInItem: number;
  toInItem: number;
  current: boolean;
}

interface PdfPageViewProps {
  doc: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  /** 搜索高亮命中（按 itemIndex 分组传入，跨 item 的匹配由父组件切分好）。稳定引用，避免重建。 */
  hits?: PdfSearchHit[];
}

interface TextItemLike { str?: string; }

/** 稳定空引用：避免 `hits = []` 默认参数每次渲染新建数组，破坏 effect deps 稳定性。 */
export const EMPTY_HITS: PdfSearchHit[] = [];

export const PdfPageView = forwardRef<HTMLDivElement, PdfPageViewProps>(
  function PdfPageView({ doc, pageNum, scale, hits = EMPTY_HITS }, _ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);
    const layerRef = useRef<TextLayer | null>(null);
    const itemsRef = useRef<TextItemLike[]>([]);
    const hitsRef = useRef<PdfSearchHit[]>(hits);

    // 把命中映射到 pdf.js textDivs，在 div 内包 <mark class="pdf-search-hl">。
    // 每页高亮只写本页 DOM（无全局竞态）；用 item.str 重建命中项内容，规避 text 节点切分。
    const applyHighlights = useCallback(() => {
      const layer = layerRef.current;
      const items = itemsRef.current;
      const hitsNow = hitsRef.current;
      const container = textLayerRef.current;
      if (!container) return;
      // 清除上一轮 mark（还原为纯文本），再重建
      container.querySelectorAll('.pdf-search-hl, .pdf-search-hl-current').forEach((m) => {
        m.replaceWith(document.createTextNode(m.textContent ?? ''));
      });
      if (!layer || !items.length) return;
      // rawIndex → textDiv 下标：str === undefined（标记内容）不产生 div；'' 占位但不在 DOM
      let divIdx = 0;
      const divByRaw = new Map<number, number>();
      for (let i = 0; i < items.length; i++) {
        if (items[i].str === undefined) continue;
        if (items[i].str) divByRaw.set(i, divIdx);
        divIdx++;
      }
      // 按 item 分组命中，逐项重建 div 内容为 [文本][mark]... 片段
      const byItem = new Map<number, PdfSearchHit[]>();
      for (const h of hitsNow) {
        const arr = byItem.get(h.itemIndex) ?? [];
        arr.push(h);
        byItem.set(h.itemIndex, arr);
      }
      for (const [itemIndex, itemHits] of byItem) {
        const div = layer.textDivs[divByRaw.get(itemIndex) ?? -1];
        const str = items[itemIndex]?.str;
        if (!div || !str) continue;
        const sorted = [...itemHits].sort((a, b) => a.fromInItem - b.fromInItem);
        const frag = document.createDocumentFragment();
        let cursor = 0;
        for (const h of sorted) {
          const from = Math.max(0, Math.min(str.length, h.fromInItem));
          const to = Math.max(from, Math.min(str.length, h.toInItem));
          if (to > from) {
            if (from > cursor) frag.append(document.createTextNode(str.slice(cursor, from)));
            const mark = document.createElement('mark');
            mark.className = h.current ? 'pdf-search-hl pdf-search-hl-current' : 'pdf-search-hl';
            mark.textContent = str.slice(from, to);
            frag.append(mark);
            cursor = to;
          }
        }
        if (cursor < str.length) frag.append(document.createTextNode(str.slice(cursor)));
        div.textContent = '';
        div.append(frag);
      }
    }, []);

    // Effect A：canvas 位图渲染。deps 不含 hits —— 搜索 prev/next（仅 activeIndex 变化）不会
    // 重绘整页位图，消除白闪与多余渲染。
    useEffect(() => {
      let cancelled = false;
      let renderTask: { cancel: () => void } | null = null;

      (async () => {
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          const outputScale = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

          const task = page.render({ canvas, canvasContext: ctx, viewport });
          renderTask = task;
          await task.promise;
        } catch (err) {
          if (!cancelled) console.error(`[PdfViewer] page ${pageNum} render failed`, err);
        }
      })();

      return () => {
        cancelled = true;
        renderTask?.cancel();
        const canvas = canvasRef.current;
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      };
    }, [doc, pageNum, scale]);

    // Effect B：文本层 —— 用 pdf.js 官方 TextLayer（ascent/宽度缩放/旋转全部正确，解决
    // 手写文本层的选区错位）。deps 不含 hits：搜索导航只重应用高亮（Effect C），不重建文本层。
    useEffect(() => {
      let cancelled = false;
      let layer: TextLayer | null = null;

      (async () => {
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const el = textLayerRef.current;
          if (!el) return;
          el.innerHTML = '';
          const textContent = await page.getTextContent();
          if (cancelled) return;
          // 与搜索索引（pdf-search.ts buildPageText 用普通 getTextContent）保持同一 item 序，
          // 保证 rawIndex → textDiv 对齐。UserUnit 极罕见，但按 page 取更稳。
          el.style.setProperty('--scale-factor', String(scale));
          el.style.setProperty('--user-unit', String(page.userUnit ?? 1));
          // 文本层容器显式设为 canvas 尺寸：pdf.js 文本层按 viewport 宽高的百分比定位，
          // 容器必须恰好等于 canvas，否则随窗口宽度偏离字形（用户反馈的宽度相关偏移）。
          el.style.width = `${viewport.width}px`;
          el.style.height = `${viewport.height}px`;
          layer = new TextLayer({ textContentSource: textContent, container: el, viewport });
          await layer.render();
          if (cancelled) { layer.cancel(); return; }
          layerRef.current = layer;
          itemsRef.current = textContent.items as TextItemLike[];
          applyHighlights();
        } catch (err) {
          if (!cancelled) console.error(`[PdfViewer] page ${pageNum} text layer failed`, err);
        }
      })();

      return () => {
        cancelled = true;
        layer?.cancel();
        layerRef.current = null;
      };
    }, [doc, pageNum, scale, applyHighlights]);

    // Effect C：搜索高亮。hits 变化时只重应用高亮，不重建文本层/canvas。
    useEffect(() => {
      hitsRef.current = hits;
      applyHighlights();
    }, [hits, applyHighlights]);

    return (
      <>
        <canvas ref={canvasRef} data-testid={`pdf-canvas-${pageNum}`} />
        <div ref={textLayerRef} className="pdf-text-layer" data-testid={`pdf-text-layer-${pageNum}`} />
      </>
    );
  },
);
