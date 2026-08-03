import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle,
  useMemo, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react';
import { loadPdfjs, pdfCMapOptions, type PDFDocumentProxy } from './pdfjs-setup';
import { useI18n } from '../../i18n';
import { formatFileSize } from '../../utils/format';
import './PdfViewer.css';

export interface PdfViewerHandle {
  nextPage: () => void;
  prevPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitWidth: () => void;
  fitPage: () => void;
}

interface PdfViewerProps {
  url: string;
  fileName: string;
  fileSize?: number;
  onOpenExternal?: () => void;
}

type Status = 'loading' | 'ready' | 'error';
type PdfErrorKind = 'password' | 'invalid' | 'load';

const RENDER_WINDOW = 2;    // 可见页前后各预渲染的页数
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.2;
const PAGE_MARGIN = 16;     // 页间纵向间距 (px)
const PAGE_PADDING_X = 48;  // 滚动区内水平留白 (px)

interface TextItemLike {
  str?: string;
  transform?: number[];
}

/** 每页占位槽 —— 白纸 + 阴影；只有窗口内的页挂载 canvas/文本层。 */
const PageSlot = memo(function PageSlot({ height, testId, children }: {
  height: number;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div className="pdf-page-slot" data-testid={testId} style={{ height }}>
      {children}
    </div>
  );
});

interface PdfPageViewProps {
  doc: PDFDocumentProxy;
  pageNum: number;
  scale: number;
}

/** 单页：canvas 位图 + 透明文本层（选择/复制）。卸载或缩放时取消渲染、清空 canvas。 */
const PdfPageView = forwardRef<HTMLDivElement, PdfPageViewProps>(
  function PdfPageView({ doc, pageNum, scale }, _ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      let cancelled = false;
      let renderTask: { cancel: () => void } | null = null;

      (async () => {
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          const canvas = canvasRef.current;
          const textLayer = textLayerRef.current;
          if (!canvas || !textLayer) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          // HiDPI 清晰渲染：backing store 用 devicePixelRatio，CSS 尺寸保持 viewport 逻辑值
          const outputScale = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

          const task = page.render({ canvas, canvasContext: ctx, viewport });
          renderTask = task;
          await task.promise;
          if (cancelled) return;

          // 文本层：手动构建 span，translate 坐标乘 scale 与 canvas 对齐
          const textContent = await page.getTextContent();
          if (cancelled) return;
          textLayer.innerHTML = '';
          for (const item of textContent.items as TextItemLike[]) {
            if (!item.str) continue;
            const [a, b, , , e, f] = item.transform ?? [1, 0, 0, 1, 0, 0];
            const span = document.createElement('span');
            span.textContent = item.str;
            span.style.transform = `translate(${e * scale}px, ${f * scale}px)`;
            span.style.fontSize = `${Math.hypot(a, b) * scale}px`;
            textLayer.appendChild(span);
          }
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

    return (
      <>
        <canvas ref={canvasRef} data-testid={`pdf-canvas-${pageNum}`} />
        <div ref={textLayerRef} className="pdf-text-layer" data-testid={`pdf-text-layer-${pageNum}`} />
      </>
    );
  },
);

export const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(
  function PdfViewer({ url, fileName, fileSize, onOpenExternal }, ref) {
    const { t } = useI18n();

    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
    const [status, setStatus] = useState<Status>('loading');
    const [error, setError] = useState<{ kind: PdfErrorKind; message: string } | null>(null);
    const [reloadNonce, setReloadNonce] = useState(0);
    const [pageCount, setPageCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [scale, setScale] = useState(1);
    const [baseHeights, setBaseHeights] = useState<number[]>([]); // 各页在 scale=1 下的高度
    const [windowRange, setWindowRange] = useState<[number, number]>([1, 0]);

    const baseWidth1Ref = useRef(0);
    const baseHeight1Ref = useRef(0);

    /** 每页顶部累计偏移（当前 scale 下）。 */
    const pageTops = useMemo(() => {
      const tops: number[] = [];
      let acc = 0;
      for (const h of baseHeights) {
        tops.push(acc);
        acc += h * scale + PAGE_MARGIN;
      }
      return tops;
    }, [baseHeights, scale]);

    /** scrollTop → 当前页（1-based，二分查找最后一条 top <= top 的页）。 */
    const pageAtScroll = useCallback((top: number) => {
      if (!baseHeights.length) return 1;
      let lo = 0, hi = baseHeights.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pageTops[mid] <= top) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans + 1;
    }, [baseHeights, pageTops]);

    const updateWindow = useCallback(() => {
      const el = scrollRef.current;
      if (!el || !baseHeights.length) return;
      const first = pageAtScroll(el.scrollTop);
      const avgH = baseHeights[0] * scale || 1;
      const visibleCount = Math.max(1, Math.ceil(el.clientHeight / avgH));
      const last = Math.min(pageCount, first + visibleCount);
      setCurrentPage(first);
      setWindowRange([
        Math.max(1, first - RENDER_WINDOW),
        Math.min(pageCount, last + RENDER_WINDOW),
      ]);
    }, [pageAtScroll, baseHeights, scale, pageCount]);

    const onScroll = useCallback(() => {
      requestAnimationFrame(updateWindow);
    }, [updateWindow]);

    const scrollToPage = useCallback((n: number) => {
      const el = scrollRef.current;
      if (!el || !pageTops.length) return;
      el.scrollTop = pageTops[Math.min(pageCount, Math.max(1, n)) - 1];
    }, [pageTops, pageCount]);

    const nextPage = useCallback(() => scrollToPage(currentPage + 1), [scrollToPage, currentPage]);
    const prevPage = useCallback(() => scrollToPage(currentPage - 1), [scrollToPage, currentPage]);

    const zoomBy = useCallback((factor: number) => {
      setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
    }, []);

    const fitWidth = useCallback(() => {
      const el = contentRef.current;
      if (!el || !baseWidth1Ref.current) return;
      const avail = el.clientWidth - PAGE_PADDING_X * 2;
      setScale(Math.min(2, Math.max(MIN_SCALE, avail / baseWidth1Ref.current)));
    }, []);

    const fitPage = useCallback(() => {
      const el = contentRef.current;
      const scroller = scrollRef.current;
      if (!el || !scroller || !baseWidth1Ref.current || !baseHeight1Ref.current) return;
      const availW = el.clientWidth - PAGE_PADDING_X * 2;
      const availH = scroller.clientHeight - 32;
      setScale(Math.min(
        Math.min(2, availW / baseWidth1Ref.current),
        Math.max(MIN_SCALE, availH / baseHeight1Ref.current),
      ));
    }, []);

    useImperativeHandle(ref, () => ({
      nextPage, prevPage,
      zoomIn: () => zoomBy(ZOOM_STEP),
      zoomOut: () => zoomBy(1 / ZOOM_STEP),
      fitWidth, fitPage,
    }), [nextPage, prevPage, zoomBy, fitWidth, fitPage]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); prevPage(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nextPage(); }
    }, [prevPage, nextPage]);

    // 加载 / 卸载 / url 切换
    useEffect(() => {
      let disposed = false;
      let loadedDoc: PDFDocumentProxy | null = null;
      const load = async () => {
        setStatus('loading');
        setError(null);
        setDoc(null);
        setPageCount(0);
        setBaseHeights([]);
        const pdfjs = await loadPdfjs();
        if (disposed) return;
        try {
          const task = pdfjs.getDocument({ url, ...pdfCMapOptions() });
          const pdfDoc = await task.promise;
          if (disposed) { void pdfDoc.loadingTask.destroy(); return; }
          loadedDoc = pdfDoc;
          setDoc(pdfDoc);
          // 预取各页基准尺寸（scale=1）：滚动数学与 fit 需要
          const heights: number[] = [];
          let w1 = 0, h1 = 0;
          for (let n = 1; n <= pdfDoc.numPages; n++) {
            const page = await pdfDoc.getPage(n);
            if (disposed) return;
            const vp = page.getViewport({ scale: 1 });
            heights.push(vp.height);
            if (n === 1) { w1 = vp.width; h1 = vp.height; }
          }
          if (disposed) return;
          baseWidth1Ref.current = w1;
          baseHeight1Ref.current = h1;
          setBaseHeights(heights);
          setPageCount(pdfDoc.numPages);
          // 初始缩放：适合宽度
          const el = contentRef.current;
          if (el && w1) {
            const avail = el.clientWidth - PAGE_PADDING_X * 2;
            setScale(Math.min(2, Math.max(MIN_SCALE, avail / w1)));
          }
          setStatus('ready');
        } catch (err) {
          if (disposed) return;
          setDoc(null);
          const kind: PdfErrorKind =
            err instanceof pdfjs.PasswordException ? 'password'
            : err instanceof pdfjs.InvalidPDFException ? 'invalid'
            : 'load';
          setError({ kind, message: err instanceof Error ? err.message : String(err) });
          setStatus('error');
        }
      };
      load();
      return () => {
        disposed = true;
        loadedDoc?.loadingTask.destroy().catch(() => {});
      };
    }, [url, reloadNonce]);

    // 就绪 / 缩放变化后刷新渲染窗口与当前页
    useEffect(() => {
      if (status !== 'ready') return;
      updateWindow();
    }, [status, baseHeights, scale, pageCount, updateWindow]);

    const pages = useMemo(() => {
      const [first, last] = windowRange;
      const arr: ReactNode[] = [];
      for (let n = 1; n <= pageCount; n++) {
        const inWindow = first <= n && n <= last;
        arr.push(
          <PageSlot
            key={n}
            height={baseHeights[n - 1] * scale}
            testId={`pdf-page-${n}`}
          >
            {inWindow && doc ? <PdfPageView doc={doc} pageNum={n} scale={scale} /> : null}
          </PageSlot>,
        );
      }
      return arr;
    }, [baseHeights, pageCount, scale, windowRange, doc]);

    const readout = t('kb.pdf.pageIndicator', {
      current: String(currentPage).padStart(String(pageCount).length, '0'),
      total: pageCount,
      percent: Math.round(scale * 100),
    });

    return (
      <div className="pdf-viewer" data-testid="pdf-viewer">
        <div
          className="pdf-scroll"
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          data-testid="pdf-scroll"
        >
          <div className="pdf-scroll-inner" ref={contentRef}>
            {baseHeights.length ? pages : null}
          </div>
        </div>

        {status === 'loading' && (
          <div className="pdf-viewer-overlay" role="status">
            <div className="pdf-spinner" aria-hidden="true" />
            <p>{t('kb.pdf.loading')}</p>
            <p className="pdf-loading-file">
              {fileName}{fileSize != null ? ` · ${formatFileSize(fileSize)}` : ''}
            </p>
          </div>
        )}

        {status === 'error' && error && (
          <div className="pdf-viewer-overlay">
            <div className="pdf-error-card">
              <p className="pdf-error-title">
                {error.kind === 'password' ? t('kb.pdf.passwordProtected')
                  : error.kind === 'invalid' ? t('kb.pdf.invalidFile')
                  : t('kb.pdf.loadFailed')}
              </p>
              <div className="pdf-error-actions">
                <button type="button" className="kb-btn" onClick={() => setReloadNonce((n) => n + 1)}>
                  {t('kb.pdf.retry')}
                </button>
                {onOpenExternal && (
                  <button type="button" className="kb-btn" onClick={onOpenExternal}>
                    {t('kb.openExternal')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {status === 'ready' && (
          <div className="kb-status-bar" data-testid="pdf-statusbar">
            <span className="pdf-statusbar-readout">{readout}</span>
          </div>
        )}
      </div>
    );
  },
);
