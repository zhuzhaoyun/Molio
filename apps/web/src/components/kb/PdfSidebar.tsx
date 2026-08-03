import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { useI18n } from '../../i18n';

interface PdfSidebarProps {
  doc: PDFDocumentProxy;
  currentPage: number;
  onJumpToPage: (n: number) => void;
}

type Tab = 'outline' | 'thumbs';

export function PdfSidebar({ doc, currentPage, onJumpToPage }: PdfSidebarProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('outline');

  return (
    <div className="pdf-sidebar" data-testid="pdf-sidebar">
      <div className="pdf-sidebar-tabs">
        <button
          type="button"
          className={`kb-btn kb-btn-ghost ${tab === 'outline' ? 'is-active' : ''}`}
          onClick={() => setTab('outline')}
          data-testid="pdf-sidebar-tab-outline"
        >
          {t('kb.pdf.outline')}
        </button>
        <button
          type="button"
          className={`kb-btn kb-btn-ghost ${tab === 'thumbs' ? 'is-active' : ''}`}
          onClick={() => setTab('thumbs')}
          data-testid="pdf-sidebar-tab-thumbs"
        >
          {t('kb.pdf.thumbnails')}
        </button>
      </div>
      <div className="pdf-sidebar-scroll">
        {tab === 'outline' ? (
          <PdfOutline doc={doc} onJump={onJumpToPage} />
        ) : (
          <PdfThumbnails doc={doc} currentPage={currentPage} onJump={onJumpToPage} />
        )}
      </div>
    </div>
  );
}

/* ── 大纲树 ── */

interface OutlineNode {
  title: string;
  dest: unknown;
  items: OutlineNode[];
}

function renderOutline(nodes: OutlineNode[], depth: number, doc: PDFDocumentProxy, onJump: (n: number) => void) {
  return nodes.map((node, i) => (
    <div key={`${depth}-${i}`}>
      <button
        type="button"
        className="pdf-outline-item"
        data-testid="pdf-outline-item"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => {
          void (async () => {
            const n = await destToPageNum(doc, node.dest);
            if (n) onJump(n);
          })();
        }}
      >
        {node.title}
      </button>
      {node.items?.length ? renderOutline(node.items, depth + 1, doc, onJump) : null}
    </div>
  ));
}

/** 解析 outline dest → 页码（1-based）。支持命名目的地。 */
async function destToPageNum(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  if (typeof dest === 'string') {
    try { dest = await doc.getDestination(dest); } catch { return null; }
  }
  if (!Array.isArray(dest) || !dest.length) return null;
  const ref = dest[0];
  try {
    const pageIndex = await doc.getPageIndex(ref);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

function PdfOutline({ doc, onJump }: { doc: PDFDocumentProxy; onJump: (n: number) => void }) {
  const { t } = useI18n();
  const [tree, setTree] = useState<OutlineNode[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    doc.getOutline().then((o) => { if (!cancelled) setTree((o ?? []) as OutlineNode[]); }).catch(() => { if (!cancelled) setTree([]); });
    return () => { cancelled = true; };
  }, [doc]);
  if (tree === null) return <div className="pdf-sidebar-empty">…</div>;
  if (!tree.length) return <div className="pdf-sidebar-empty">{t('kb.pdf.noOutline')}</div>;
  return <div className="pdf-outline">{renderOutline(tree, 0, doc, onJump)}</div>;
}

/* ── 缩略图 ── */

function PdfThumbnails({ doc, currentPage, onJump }: { doc: PDFDocumentProxy; currentPage: number; onJump: (n: number) => void }) {
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);
  return (
    <div className="pdf-thumbs">
      {pages.map((n) => (
        <PdfThumb key={n} doc={doc} pageNum={n} current={n === currentPage} onJump={onJump} />
      ))}
    </div>
  );
}

const THUMB_WIDTH = 140;

function PdfThumb({ doc, pageNum, current, onJump }: {
  doc: PDFDocumentProxy; pageNum: number; current: boolean; onJump: (n: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  // 进入视口才渲染
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setVisible(true); io.disconnect(); }
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const vp1 = page.getViewport({ scale: 1 });
        const scale = THUMB_WIDTH / vp1.width;
        const vp = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const t = page.render({ canvas, canvasContext: ctx, viewport: vp });
        task = t;
        await t.promise;
      } catch (err) {
        if (!cancelled) console.error(`[PdfViewer] thumb ${pageNum} failed`, err);
      }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, pageNum, visible]);

  // 当前页高亮 + 自动滚入视口
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <div
      ref={ref}
      className={`pdf-thumb${current ? ' pdf-thumb-current' : ''}`}
      data-testid={current ? 'pdf-thumb-current' : 'pdf-thumb'}
      onClick={() => onJump(pageNum)}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
