import { forwardRef, useEffect, useRef } from 'react';
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

interface TextItemLike { str?: string; transform?: number[]; hasEOL?: boolean; }

/** 稳定空引用：避免 `hits = []` 默认参数每次渲染新建数组，破坏 effect deps 稳定性。 */
export const EMPTY_HITS: PdfSearchHit[] = [];

/** 2D 仿射矩阵组合 m1 ∘ m2（pdf.js Util.transform 等价）。 */
function compose(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyTransform(
  span: HTMLSpanElement, e: number, f: number, angle: number, fontSize: number, scaleY: number,
) {
  span.style.transform = `translate(${e}px, ${f}px) rotate(${angle}rad) scaleY(${scaleY})`;
  span.style.fontSize = `${fontSize}px`;
}

function makeSpan(
  text: string, isHit: boolean, current: boolean,
  e: number, f: number, angle: number, fontSize: number, scaleY: number,
) {
  const span = document.createElement('span');
  span.textContent = text;
  if (isHit) span.className = current ? 'pdf-search-hl pdf-search-hl-current' : 'pdf-search-hl';
  applyTransform(span, e, f, angle, fontSize, scaleY);
  return span;
}

/** 把含命中的 item 切成 [普通][命中][普通] 片段。hits 需按 fromInItem 升序。 */
function appendSegmented(
  layer: HTMLElement, str: string, hits: PdfSearchHit[],
  e: number, f: number, angle: number, fontSize: number, scaleY: number,
) {
  const sorted = [...hits].sort((x, y) => x.fromInItem - y.fromInItem);
  let cursor = 0;
  for (const hit of sorted) {
    const from = Math.max(0, hit.fromInItem);
    const to = Math.min(str.length, hit.toInItem);
    if (from > cursor) layer.appendChild(makeSpan(str.slice(cursor, from), false, false, e, f, angle, fontSize, scaleY));
    if (to > from) layer.appendChild(makeSpan(str.slice(from, to), true, hit.current, e, f, angle, fontSize, scaleY));
    cursor = Math.max(cursor, to);
  }
  if (cursor < str.length) layer.appendChild(makeSpan(str.slice(cursor), false, false, e, f, angle, fontSize, scaleY));
}

export const PdfPageView = forwardRef<HTMLDivElement, PdfPageViewProps>(
  function PdfPageView({ doc, pageNum, scale, hits = EMPTY_HITS }, _ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);

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

    // Effect B：文本层重建（含搜索高亮）。仅当 hits 变化时重跑，不触碰 canvas。
    useEffect(() => {
      let cancelled = false;

      (async () => {
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const textLayer = textLayerRef.current;
          if (!textLayer) return;

          const textContent = await page.getTextContent();
          if (cancelled) return;
          textLayer.innerHTML = '';
          const items = textContent.items as TextItemLike[];
          const hitByItem = new Map<number, PdfSearchHit[]>();
          for (const hit of hits) {
            const arr = hitByItem.get(hit.itemIndex) ?? [];
            arr.push(hit);
            hitByItem.set(hit.itemIndex, arr);
          }
          items.forEach((item, itemIndex) => {
            if (!item.str) return;
            // 组合 viewport×item 变换：包含旋转/倾斜（c/d 分量），fontSize 已含 scale
            const [a, b, c, d, e, f] = compose(viewport.transform, item.transform ?? [1, 0, 0, 1, 0, 0]);
            const angle = Math.atan2(b, a);
            const fontSize = Math.hypot(a, b);
            const scaleY = Math.hypot(c, d) / (fontSize || 1);
            const itemHits = hitByItem.get(itemIndex);
            if (itemHits?.length) {
              appendSegmented(textLayer, item.str, itemHits, e, f, angle, fontSize, scaleY);
            } else {
              textLayer.appendChild(makeSpan(item.str, false, false, e, f, angle, fontSize, scaleY));
            }
          });
        } catch (err) {
          if (!cancelled) console.error(`[PdfViewer] page ${pageNum} text layer failed`, err);
        }
      })();

      return () => { cancelled = true; };
    }, [doc, pageNum, scale, hits]);

    return (
      <>
        <canvas ref={canvasRef} data-testid={`pdf-canvas-${pageNum}`} />
        <div ref={textLayerRef} className="pdf-text-layer" data-testid={`pdf-text-layer-${pageNum}`} />
      </>
    );
  },
);
