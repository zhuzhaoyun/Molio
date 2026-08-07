# PDF 预览实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Molio 知识库支持 PDF 内嵌预览——文件树点击或 `?file=` 打开后，在主内容区渲染可翻页、可缩放、可选中文本的 PDF 查看器。

**Architecture:** 自定义 React 查看器 `PdfViewer`，底层用 `pdfjs-dist`（与 Obsidian 同源）。`pdfjs-dist` 通过动态 `import()` 懒加载，worker 用 Vite `?url` 资产导入，CJK cmaps 用 `vite-plugin-static-copy` 拷入产物。查看器内部滚动容器管理懒渲染窗口（±2 页）、canvas + 文本层绘制、缩放与页码状态；头栏通过 `forwardRef` 命令式控制翻页/缩放。后端零改动，复用现有 `GET /api/knowledge/vaults/:id/raw/*`（已支持 `application/pdf` + HTTP Range）。

**Tech Stack:** React 19 / TypeScript / Vite 6 / `pdfjs-dist@6.2.108` / `vite-plugin-static-copy@^4.1.1` / Playwright E2E

## Global Constraints

- `pdfjs-dist` **精确锁定 `6.2.108`**（API 与 worker 版本必须一致）；worker 路径 `pdfjs-dist/build/pdf.worker.min.mjs`（已在 unpkg 核实存在）。
- Worker 必须用 Vite `?url` 资产导入：`import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`。
- CJK cmaps 拷到构建产物 `cmaps/`，`cMapUrl = import.meta.env.BASE_URL + 'cmaps/'`，`cMapPacked: true`。
- 所有颜色来自 `tokens.css` 变量，**禁止新增硬编码 hex**；页面纸面本身为纯白 `#fff`。
- 按钮复用 `.kb-btn` / `.kb-btn-ghost`，**不发明新按钮样式**；分隔复用 `.kb-header-actions-divider`；状态条复用 `.kb-status-bar`（该 class 在 `KbMainContent` 中仅 `category === 'text'` 渲染，PDF 分支使用不会重复）。
- i18n：新增扁平 `kb.pdf.*` keys，`en.ts` 与 `zh.ts` 双语同步；插值用 `{param}` 语法（`translate()` 已支持）。
- 内存纪律（对齐仓库近期 leak 修复规范）：组件卸载 / url 切换 / 错误时 `pdfDoc.destroy()` + 全部 `RenderTask.cancel()` + 清空 canvas；忽略在途 promise 结果。
- 懒渲染窗口 ±2 页；缩放范围 `[0.25, 4]`，步进 ×1.2。
- E2E：改动 `src/components/kb/` 必须保持 `publish-flow.spec.ts` 全绿；新增 spec 声明 `@area kb` / `@priority P1`。
- 测试层说明：web 无单元测试框架，**行为验证靠 Playwright E2E**；每任务的门禁是 `pnpm typecheck` + `pnpm build`（+ E2E 在 Task 4）。

---

### Task 1: pdf.js 基建（依赖 + Vite cmaps + 惰性加载模块）

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`
- Create: `apps/web/src/components/kb/pdfjs-setup.ts`

**Interfaces:**
- Consumes: 无（第一个任务）。
- Produces:
  - `loadPdfjs(): Promise<typeof import('pdfjs-dist')>` — 惰性加载并设置 `GlobalWorkerOptions.workerSrc`（幂等）。
  - `pdfCMapOptions(): { cMapUrl: string; cMapPacked: boolean }` — CJK 字形映射选项。
  - `export type { PDFDocumentProxy }` — 从 `pdfjs-setup.ts` 再导出，供 Task 2 使用。

- [ ] **Step 1: 添加依赖**

在 `apps/web/package.json` 的 `dependencies` 中加入 `"pdfjs-dist": "6.2.108"`（精确版本），`devDependencies` 中加入 `"vite-plugin-static-copy": "^4.1.1"`。然后用 pnpm 安装：

```bash
cd apps/web
pnpm add -E pdfjs-dist@6.2.108
pnpm add -D vite-plugin-static-copy@^4.1.1
```

- [ ] **Step 2: 验证 worker 文件存在**

```bash
ls apps/web/node_modules/pdfjs-dist/build/pdf.worker.min.mjs
# 期望：文件存在。若不存在（版本结构变化），把后续所有 pdf.worker.min.mjs 路径改为实际文件名，并如实说明。
```

- [ ] **Step 3: 配置 Vite 拷贝 cmaps**

修改 `apps/web/vite.config.ts` 为：

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    // pdf.js CJK 字形映射 —— 构建期拷一次；pdfCMapOptions() 通过 BASE_URL + 'cmaps/' 引用
    viteStaticCopy({
      targets: [{ src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'cmaps' }],
    }),
  ],
  resolve: {
    alias: {
      // Alias for vendored doocs-md module
      '@molio/doocs-md': path.resolve(__dirname, 'vendor/doocs-md'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env['MOLIO_DAEMON'] ?? 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 4: 创建惰性加载模块**

创建 `apps/web/src/components/kb/pdfjs-setup.ts`：

```ts
/**
 * pdfjs-dist 惰性加载器。留在主 bundle 之外——仅在首次打开 PDF 时取回。
 * worker 与 CJK cmaps 在此集中配置。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';

// `?url` 让 Vite 构建期把 worker 作为资产发射；dev/build 路径稳定，pnpm 下不依赖 node_modules 猜测。
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type { PDFDocumentProxy };

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** 惰性加载 pdfjs-dist 并设置 worker 源（幂等）。 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return m;
    });
  }
  return pdfjsPromise;
}

/** getDocument() 选项 —— CJK cmaps，让中文 PDF 字形正确渲染。 */
export function pdfCMapOptions(): { cMapUrl: string; cMapPacked: boolean } {
  return { cMapUrl: `${import.meta.env.BASE_URL}cmaps/`, cMapPacked: true };
}
```

- [ ] **Step 5: 门禁验证**

```bash
cd apps/web && pnpm typecheck && pnpm build
# 期望：均通过；构建产物 dist/ 下出现 cmaps/ 目录（ls dist/cmaps | head）。
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/vite.config.ts apps/web/src/components/kb/pdfjs-setup.ts
git commit -m "feat(web): pdf.js 基建 —— 依赖、worker 与 CJK cmaps"
```

---

### Task 2: PdfViewer 组件（渲染引擎 + 文本层 + 懒渲染 + 缩放 + 状态条 + 错误处理）

**Files:**
- Create: `apps/web/src/components/kb/PdfViewer.tsx`
- Create: `apps/web/src/components/kb/PdfViewer.css`
- Modify: `apps/web/src/i18n/locales/en.ts`、`apps/web/src/i18n/locales/zh.ts`（`kb.pdf.*` keys）

**Interfaces:**
- Consumes:
  - `loadPdfjs()` / `pdfCMapOptions()` / `type PDFDocumentProxy` 来自 `./pdfjs-setup`（Task 1）。
  - `formatFileSize` 来自 `../../utils/format`（已在 KbMainContent 使用）。
  - `useI18n` 来自 `../../i18n`（`t(key, params)`，`{param}` 插值）。
- Produces:
  - `export interface PdfViewerHandle { nextPage(): void; prevPage(): void; zoomIn(): void; zoomOut(): void; fitWidth(): void; fitPage(): void }` — Task 3 头栏命令式调用。
  - `export const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>`，Props：`{ url: string; fileName: string; fileSize?: number; onOpenExternal?: () => void }`。
  - 渲染根元素 `data-testid="pdf-viewer"`；canvas `data-testid="pdf-canvas-N"`；文本层 `data-testid="pdf-text-layer-N"`；状态条 `data-testid="pdf-statusbar"`（Task 4 E2E 依赖）。

- [ ] **Step 1: 添加 i18n keys（zh 与 en 同步）**

在 `apps/web/src/i18n/locales/zh.ts` 与 `en.ts` 的 `kb` 对象中追加（保持扁平 key 风格，放在 `kb.*` 区块内）：

zh.ts：
```ts
  'kb.pdf.prevPage': '上一页',
  'kb.pdf.nextPage': '下一页',
  'kb.pdf.zoomIn': '放大',
  'kb.pdf.zoomOut': '缩小',
  'kb.pdf.fitWidth': '适合宽度',
  'kb.pdf.fitPage': '适合页面',
  'kb.pdf.loading': '正在加载 PDF…',
  'kb.pdf.passwordProtected': '这个 PDF 已加密，暂时无法预览。可以试试用外部程序打开。',
  'kb.pdf.invalidFile': '这个 PDF 文件已损坏或格式无效，无法预览。',
  'kb.pdf.loadFailed': 'PDF 加载失败。',
  'kb.pdf.retry': '重试',
  'kb.pdf.pageIndicator': '第 {current} / {total} 页 · {percent}%',
```

en.ts：
```ts
  'kb.pdf.prevPage': 'Previous page',
  'kb.pdf.nextPage': 'Next page',
  'kb.pdf.zoomIn': 'Zoom in',
  'kb.pdf.zoomOut': 'Zoom out',
  'kb.pdf.fitWidth': 'Fit to width',
  'kb.pdf.fitPage': 'Fit to page',
  'kb.pdf.loading': 'Loading PDF…',
  'kb.pdf.passwordProtected': "This PDF is password-protected and can't be previewed here.",
  'kb.pdf.invalidFile': "This PDF is corrupted or invalid and can't be previewed.",
  'kb.pdf.loadFailed': 'Failed to load the PDF.',
  'kb.pdf.retry': 'Retry',
  'kb.pdf.pageIndicator': 'Page {current} / {total} · {percent}%',
```

- [ ] **Step 2: 创建 PdfViewer.tsx 主体**

创建 `apps/web/src/components/kb/PdfViewer.tsx`（完整内容如下）：

```tsx
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

          const task = page.render({ canvasContext: ctx, viewport });
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
          if (disposed) { void pdfDoc.destroy(); return; }
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
        loadedDoc?.destroy().catch(() => {});
      };
    }, [url, reloadNonce]);

- [ ] **Step 3: 窗口更新 + 渲染 + 状态条**

在 Step 2 的组件内继续追加（`updateWindow` 之后、return 之前）：

```tsx
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
```

- [ ] **Step 4: 创建 PdfViewer.css**

创建 `apps/web/src/components/kb/PdfViewer.css`：

```css
/* ══════════ PDF Preview ══════════ */

.kb-content-area.kb-pdf-area {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.pdf-viewer {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.pdf-scroll {
  flex: 1;
  overflow-y: auto;
  background: var(--bg);
  outline: none;
}

.pdf-scroll-inner {
  padding: 16px 48px 48px;
}

.pdf-page-slot {
  position: relative;
  margin: 0 auto 16px;
  background: #fff;
  box-shadow: var(--shadow-md);
}

.pdf-page-slot:last-child {
  margin-bottom: 0;
}

.pdf-page-slot canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.pdf-text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  color: transparent;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.pdf-text-layer span {
  position: absolute;
  transform-origin: 0 0;
  white-space: pre;
  color: transparent;
}

.pdf-text-layer ::selection {
  background: var(--selected-soft);
  color: transparent;
}

.pdf-viewer-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  background: var(--bg);
  z-index: 2;
}

.pdf-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: pdf-spin 0.8s linear infinite;
}

@keyframes pdf-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .pdf-spinner { animation: none; }
}

.pdf-loading-file {
  font-size: 13px;
  color: var(--text-soft);
}

.pdf-error-card {
  max-width: 420px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pdf-error-title {
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
}

.pdf-error-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.pdf-statusbar-readout {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 5: 核对清理逻辑**

确认 `PdfViewer.tsx` 中**没有** `docRef` / `docRefCurrent` 标识符；load effect 顶部声明 `let loadedDoc: PDFDocumentProxy | null = null`，成功处 `loadedDoc = pdfDoc`，cleanup 中 `loadedDoc?.destroy().catch(() => {})`。卸载 / url 切换会 destroy 旧文档，符合内存纪律。

- [ ] **Step 6: 门禁验证**

```bash
cd apps/web && pnpm typecheck && pnpm build
# 期望：通过。TS 若有报错（如 TextItemLike、React.KeyboardEvent 命名空间、unused），按报错修正。
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/kb/PdfViewer.tsx apps/web/src/components/kb/PdfViewer.css apps/web/src/i18n/locales/en.ts apps/web/src/i18n/locales/zh.ts
git commit -m "feat(web): PdfViewer 组件 —— canvas 渲染、文本层、懒渲染、缩放与错误处理"
```

---

### Task 3: 接入 KbMainContent（pdf 分类 + 头栏操作组）

**Files:**
- Modify: `apps/web/src/components/kb/KbMainContent.tsx`

**Interfaces:**
- Consumes:
  - `PdfViewer`（default-shaped lazy 组件）与 `type PdfViewerHandle` 来自 `./PdfViewer`（Task 2）。
  - `api.rawFileUrl(vaultId, filePath)`（已有）。
  - `t('kb.pdf.*')`（Task 2 已加）。
- Produces: 无（收尾接线）。

- [ ] **Step 1: 引入 lazy 组件与 ref 类型**

在 `KbMainContent.tsx` 现有 lazy 引入（`KbCodeMirrorViewer` 下方，第 31-33 行附近）追加：

```tsx
import type { PdfViewerHandle } from './PdfViewer';

const PdfViewer = lazy(() => import('./PdfViewer').then((m) => ({ default: m.PdfViewer })));
```

- [ ] **Step 2: 新增 pdf 分类**

修改文件分类逻辑（第 54-70 行）：

```tsx
/** File categories for rendering strategy */
type FileCategory = 'text' | 'image' | 'video' | 'audio' | 'binary' | 'pdf';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg']);
const PDF_EXTS = new Set(['.pdf']);
const BINARY_EXTS = new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls']);

function getFileCategory(fileName: string): FileCategory {
  const lastDot = fileName.lastIndexOf('.');
  const ext = lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'text';
}
```

> 注意：`.pdf` 从 `BINARY_EXTS` 移除，加入新 `PDF_EXTS`（避免 binary 分支命中 PDF）。

- [ ] **Step 3: 声明 pdfRef**

在 `KbMainContent` 函数体内部（已有 `cmRef` 的 useRef 附近）追加：

```tsx
const pdfRef = useRef<PdfViewerHandle>(null);
```

- [ ] **Step 4: 头栏 PDF 操作组**

在 CM viewer 操作组（第 470-527 行 `{category === 'text' && selectedFile && isCmPath && (...)}` 的闭合 `)}` 之后）、binary openExternal 按钮（第 530 行）之前，插入：

```tsx
{/* PDF viewer: 翻页 / 缩放 / 适配（命令式走 pdfRef） */}
{category === 'pdf' && selectedFile && (
  <>
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.prevPage()}
      title={t('kb.pdf.prevPage')}
      data-testid="kb-btn-pdf-prev"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.nextPage()}
      title={t('kb.pdf.nextPage')}
      data-testid="kb-btn-pdf-next"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
    <span className="kb-header-actions-divider" />
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.zoomOut()}
      title={t('kb.pdf.zoomOut')}
      data-testid="kb-btn-pdf-zoom-out"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.zoomIn()}
      title={t('kb.pdf.zoomIn')}
      data-testid="kb-btn-pdf-zoom-in"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    <span className="kb-header-actions-divider" />
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.fitWidth()}
      title={t('kb.pdf.fitWidth')}
      data-testid="kb-btn-pdf-fit-width"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <polyline points="18 8 22 12 18 16" />
        <polyline points="6 8 2 12 6 16" />
        <line x1="2" y1="12" x2="22" y2="12" />
      </svg>
    </button>
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.fitPage()}
      title={t('kb.pdf.fitPage')}
      data-testid="kb-btn-pdf-fit-page"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
      </svg>
    </button>
  </>
)}
```

- [ ] **Step 5: 扩展「用外部程序打开」到 pdf 分类**

把 binary openExternal 按钮的条件（第 530 行）从：

```tsx
{category === 'binary' && isElectron && (
```
改为：
```tsx
{(category === 'binary' || category === 'pdf') && isElectron && (
```

- [ ] **Step 6: 渲染分支插入 PDF 查看器**

在 body 的 binary 分支（第 735 行 `) : category === 'binary' ? (`）**之前**插入：

```tsx
      ) : category === 'pdf' && vaultId ? (
        <div className="kb-content-area kb-pdf-area">
          <ViewerErrorBoundary
            key={retryNonce}
            onRetry={() => { setRetryNonce((n) => n + 1); onForceLoad?.(); }}
            onOpenExternal={isElectron ? handleOpenExternal : undefined}
          >
            <Suspense fallback={<div className="kb-empty-state"><p>Loading...</p></div>}>
              <PdfViewer
                ref={pdfRef}
                url={api.rawFileUrl(vaultId, selectedFile)}
                fileName={fileName}
                fileSize={fileContent?.size}
                onOpenExternal={isElectron ? handleOpenExternal : undefined}
              />
            </Suspense>
          </ViewerErrorBoundary>
        </div>
```

> 说明：`ViewerErrorBoundary` 与 `Suspense`、`api`、`retryNonce`、`isElectron`、`handleOpenExternal`、`fileContent`、`selectedFile` 均已在文件中存在，无需新增导入（`lazy`/`Suspense` 已在第 8 行导入）。

- [ ] **Step 7: 门禁验证**

```bash
cd apps/web && pnpm typecheck && pnpm build
```

手动冒烟（需 daemon + web 在跑）：

```bash
# 终端1: pnpm dev:daemon ; 终端2: cd apps/web && pnpm dev
# 浏览器打开 http://localhost:5173/knowledge?vault=<id>&file=某个.pdf
# 期望：PDF 渲染出白纸页面、可选中文本、头栏翻页/缩放按钮生效、状态条显示“第 001 / N 页 · xxx%”
```

- [ ] **Step 8: 回归确认 + Commit**

```bash
cd apps/web && npx playwright test publish-flow.spec.ts
# 期望：通过（CLAUDE.md 强制：改 src/components/kb/ 必须保持 publish-flow 全绿）

git add apps/web/src/components/kb/KbMainContent.tsx
git commit -m "feat(web): 知识库接入 PDF 预览 —— 分类、头栏操作组、渲染分支"
```

---

### Task 4: E2E 测试（fixture 生成 + spec）

**Files:**
- Create: `apps/web/scripts/generate-sample-pdf.mjs`
- Create: `apps/web/e2e/fixtures/sample.pdf`（由脚本生成后提交）
- Create: `apps/web/e2e/pdf-preview.spec.ts`

**Interfaces:**
- Consumes: `createTempVault` / `cleanupTempVault` / `type TempVault` 来自 `./helpers/cleanup`；PdfViewer 的 `data-testid`（Task 2 产出）。
- Produces: E2E 覆盖「文件树点击打开」「翻页」「缩放」。

- [ ] **Step 1: 创建 fixture 生成脚本**

创建 `apps/web/scripts/generate-sample-pdf.mjs`：

```js
/**
 * 生成一个最小但合法的 2 页 PDF（带 ASCII 文本层），写入 e2e/fixtures/sample.pdf。
 * 用法：node scripts/generate-sample-pdf.mjs
 * 生成的 PDF 供 pdf-preview.spec.ts 断言文本层与翻页。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const content1 = 'BT /F1 24 Tf 72 720 Td (Hello PDF - Page 1) Tj ET';
const content2 = 'BT /F1 24 Tf 72 720 Td (Hello PDF - Page 2) Tj ET';

const objects = [
  null,
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let out = '%PDF-1.4\n';
const offsets = [0];
for (let i = 1; i <= 7; i++) {
  offsets[i] = Buffer.byteLength(out, 'latin1');
  out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(out, 'latin1');
out += `xref\n0 8\n0000000000 65535 f \n`;
for (let i = 1; i <= 7; i++) {
  out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
out += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const outDir = join(__dirname, '..', 'e2e', 'fixtures');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'sample.pdf'), out);
console.log(`wrote ${join(outDir, 'sample.pdf')} (${Buffer.byteLength(out, 'latin1')} bytes)`);
```

- [ ] **Step 2: 生成并验证 fixture**

```bash
cd apps/web && node scripts/generate-sample-pdf.mjs
# 期望：输出 wrote .../e2e/fixtures/sample.pdf（约 900+ 字节）

# 快速校验能被本机预览器/命令识别：
file e2e/fixtures/sample.pdf
# 期望：显示 "PDF document, version 1.4"
```

- [ ] **Step 3: 编写 E2E spec**

创建 `apps/web/e2e/pdf-preview.spec.ts`：

```ts
/**
 * @area kb
 * @priority P1
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

test.describe('知识库 PDF 预览', () => {
  let vault: TempVault;

  test.beforeAll(async () => {
    vault = await createTempVault('e2e-pdf-preview');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'), path.join(vault.path, 'sample.pdf'));
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('文件树点击 PDF → 内嵌查看器渲染', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await page.locator('.kb-tree-item').filter({ hasText: 'sample.pdf' }).click({ timeout: 10_000 });

    const viewer = page.locator('[data-testid="pdf-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 15_000 });
    // 首页 canvas 渲染
    await expect(viewer.locator('[data-testid="pdf-canvas-1"]')).toBeVisible();
    // 状态条显示第 1 / 2 页
    await expect(viewer.locator('[data-testid="pdf-statusbar"]')).toContainText('第 1 / 2');
    // 文本层有真实文本（1 个 span）
    await expect(viewer.locator('[data-testid="pdf-text-layer-1"] span')).toHaveCount(1);
  });

  test('翻页与缩放按钮生效', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('kb-btn-pdf-next').click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 2 / 2');

    const before = await page.getByTestId('pdf-statusbar').textContent();
    await page.getByTestId('kb-btn-pdf-zoom-in').click();
    await expect(page.getByTestId('pdf-statusbar')).not.toHaveText(before ?? '');
  });
});
```

- [ ] **Step 4: 运行 E2E**

前置条件：daemon + web 已启动（`pnpm dev`）。

```bash
cd apps/web && npx playwright test pdf-preview.spec.ts
# 期望：2 个用例全绿
```

若失败，按 CLAUDE.md 错误驱动规则处理：先定位是组件 bug 还是测试 bug，修复并**在本 spec 或对应位置补一条能复现断言的用例**，再跑全绿。

- [ ] **Step 5: 全量回归（核心流程保护）**

```bash
cd apps/web && npx playwright test
# 期望：全绿（尤其 publish-flow.spec.ts 与知识库相关 spec）
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/scripts/generate-sample-pdf.mjs apps/web/e2e/fixtures/sample.pdf apps/web/e2e/pdf-preview.spec.ts
git commit -m "test(web): PDF 预览 E2E —— fixture 生成、渲染/翻页/缩放用例"
```

---

## Self-Review 结果

- **Spec 覆盖**：渲染（T2）、翻页/缩放/适配（T2 + T3 头栏）、文字选择（T2 文本层）、状态条（T2）、错误处理（T2）、i18n（T2）、E2E（T4）——spec 的一期目标全部有对应任务。非目标（搜索/大纲/密码输入/内嵌）未实现，符合设计。
- **占位符扫描**：无 TBD/TODO；初稿的 `docRefCurrent` 笔误已改为内联正确写法（`loadedDoc` 局部变量），`b` 解构缺失与 `React.KeyboardEvent` 未导入也已在代码块内修正。
- **类型一致性**：`PdfViewerHandle` 方法名在 T2 定义与 T3 头栏调用一致（`prevPage/nextPage/zoomIn/zoomOut/fitWidth/fitPage`）；`data-testid`（`pdf-canvas-N`/`pdf-text-layer-N`/`pdf-statusbar`/`kb-btn-pdf-*`）在 T2 产出与 T4 断言一致；`kb.pdf.*` keys 在 T2 定义与 T3/T4 使用一致。
