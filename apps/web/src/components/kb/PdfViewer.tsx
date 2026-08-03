import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle,
  useMemo, useRef, useState, type KeyboardEvent, type ReactNode,
} from 'react';
import { loadPdfjs, pdfCMapOptions, type PDFDocumentProxy } from './pdfjs-setup';
import { PdfPageView, EMPTY_HITS } from './PdfPageView';
import type { PdfSearchHit } from './PdfPageView';
import { PdfSearchBar } from './PdfSearchBar';
import { PdfSidebar } from './PdfSidebar';
import { buildPageText, searchAll, type PdfMatch, type PdfPageText } from './pdf-search';
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
  selectAll: () => void;
  toggleSearch: () => void;
  toggleSidebar: () => void;
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

    const [searchVisible, setSearchVisible] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [matches, setMatches] = useState<PdfMatch[]>([]);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    // 文本索引缓存按 doc 身份隔离：切换文件后旧文档的在途 searchAll 不会污染新缓存。
    const textIndexRef = useRef<{ doc: PDFDocumentProxy; map: Map<number, PdfPageText> } | null>(null);

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
      // ceil：浏览器 scrollTop 按整像素截断，页顶边界为小数时（常见于 fit-width 缩放）
      // 直接赋值会被截到边界前 1px，导致 pageAtScroll 判回上一页、页码指示不前进。
      // 向上取整保证落点严格越过页顶边界。
      el.scrollTop = Math.ceil(pageTops[Math.min(pageCount, Math.max(1, n)) - 1]);
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

    /** 选中当前页文本层全部文本（选区菜单「选择全部」用）。 */
    const selectAll = useCallback(() => {
      const layer = document.querySelector(`[data-testid="pdf-text-layer-${currentPage}"]`) as HTMLElement | null;
      if (!layer) return;
      const range = document.createRange();
      range.selectNodeContents(layer);
      const s = window.getSelection();
      if (!s) return;
      s.removeAllRanges();
      s.addRange(range);
    }, [currentPage]);

    /** 单页文本索引缓存（跨搜索复用，按 doc 身份隔离，切换文件即丢弃）。 */
    const getTextCached = useCallback(async (n: number) => {
      let entry = textIndexRef.current;
      if (!entry || entry.doc !== doc) {
        entry = { doc: doc!, map: new Map() };
        textIndexRef.current = entry;
      }
      const cache = entry.map;
      let t = cache.get(n);
      if (!t) {
        const page = await doc!.getPage(n);
        t = await buildPageText(page);
        cache.set(n, t);
      }
      return t;
    }, [doc]);

    const goToMatch = useCallback((i: number) => {
      if (!matches.length) return;
      const idx = ((i % matches.length) + matches.length) % matches.length;
      setActiveIndex(idx);
      scrollToPage(matches[idx].pageNum);
    }, [matches, scrollToPage]);

    // 搜索执行：300ms debounce，空查询清除
    useEffect(() => {
      if (!doc) return;
      const q = searchQuery.trim();
      if (!q) {
        setMatches([]); setActiveIndex(-1); setSearching(false);
        return;
      }
      let cancelled = false;
      const timer = setTimeout(async () => {
        setSearching(true);
        try {
          const found = await searchAll(doc, q, getTextCached);
          if (cancelled) return;
          setMatches(found);
          setActiveIndex(found.length ? 0 : -1);
          if (found.length) scrollToPage(found[0].pageNum);
        } catch (err) {
          if (cancelled) return;
          console.error('[PdfViewer] search failed', err);
          setMatches([]);
          setActiveIndex(-1);
          setSearching(false);
        } finally {
          if (!cancelled) setSearching(false);
        }
      }, 300);
      return () => { cancelled = true; clearTimeout(timer); };
    }, [searchQuery, doc, getTextCached, scrollToPage]);

    /** 每页命中（按 itemIndex 分组，跨 item 的匹配由 searchAll 切分好）。 */
    const hitsByPage = useMemo(() => {
      const map = new Map<number, PdfSearchHit[]>();
      matches.forEach((m, i) => {
        const arr = map.get(m.pageNum) ?? [];
        arr.push({ itemIndex: m.itemIndex, fromInItem: m.fromInItem, toInItem: m.toInItem, current: i === activeIndex });
        map.set(m.pageNum, arr);
      });
      return map;
    }, [matches, activeIndex]);

    useImperativeHandle(ref, () => ({
      nextPage, prevPage,
      zoomIn: () => zoomBy(ZOOM_STEP),
      zoomOut: () => zoomBy(1 / ZOOM_STEP),
      fitWidth, fitPage, selectAll,
      toggleSearch: () => setSearchVisible((v) => !v),
      toggleSidebar: () => setSidebarOpen((v) => !v),
    }), [nextPage, prevPage, zoomBy, fitWidth, fitPage, selectAll]);

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
        let pdfjs: typeof import('pdfjs-dist') | null = null;
        try {
          pdfjs = await loadPdfjs();
          if (disposed) return;
          const task = pdfjs.getDocument({ url, ...pdfCMapOptions() });
          const pdfDoc = await task.promise;
          if (disposed) { void pdfDoc.loadingTask.destroy(); return; }
          loadedDoc = pdfDoc;
          setDoc(pdfDoc);
          textIndexRef.current = null; // 切换文件：丢弃旧文档的文本索引缓存
          // 并行预取各页基准尺寸（scale=1）——避免大 PDF 串行 getPage 阻塞首屏
          const pageObjs = await Promise.all(
            Array.from({ length: pdfDoc.numPages }, (_, i) => pdfDoc.getPage(i + 1)),
          );
          if (disposed) return;
          const viewports = pageObjs.map((p) => p.getViewport({ scale: 1 }));
          const heights = viewports.map((v) => v.height);
          const w1 = viewports[0]?.width ?? 0;
          const h1 = heights[0] ?? 0;
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
            pdfjs && err instanceof pdfjs.PasswordException ? 'password'
            : pdfjs && err instanceof pdfjs.InvalidPDFException ? 'invalid'
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
            {inWindow && doc ? <PdfPageView doc={doc} pageNum={n} scale={scale} hits={hitsByPage.get(n) ?? EMPTY_HITS} /> : null}
          </PageSlot>,
        );
      }
      return arr;
    }, [baseHeights, pageCount, scale, windowRange, doc, hitsByPage]);

    const readout = t('kb.pdf.pageIndicator', {
      current: String(currentPage).padStart(String(pageCount).length, '0'),
      total: pageCount,
      percent: Math.round(scale * 100),
    });

    return (
      <div className="pdf-viewer" data-testid="pdf-viewer">
        {status === 'ready' && searchVisible && (
          <PdfSearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            total={matches.length}
            activeIndex={activeIndex}
            searching={searching}
            onPrev={() => goToMatch(activeIndex - 1)}
            onNext={() => goToMatch(activeIndex + 1)}
            onClose={() => { setSearchVisible(false); setMatches([]); setActiveIndex(-1); setSearchQuery(''); }}
          />
        )}
        <div className="pdf-body">
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
          {sidebarOpen && doc && (
            <PdfSidebar doc={doc} currentPage={currentPage} onJumpToPage={scrollToPage} />
          )}
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
