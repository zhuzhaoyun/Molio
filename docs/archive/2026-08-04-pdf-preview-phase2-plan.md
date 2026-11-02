# PDF 预览二期实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 PDF 预览的「闭环」——选区右键菜单（复制/选择全部/问答选中内容）、PDF 内搜索高亮、大纲/缩略图侧栏，并做首屏优化与文本层旋转对齐。

**Architecture:** 在一期 `PdfViewer`（pdfjs-dist 自定义查看器）之上扩展。`PdfPageView` 抽出为独立文件并修旋转对齐（组合 viewport×item 变换）；新增纯逻辑 `pdf-search.ts`（索引 + 跨 item 匹配映射）；`PdfSearchBar` 为搜索条 UI；`PdfSidebar` 为大纲/缩略图面板；`KbMainContent` 接右键菜单（复用现有 `ContextMenu` + `onAskAboutSelection`）与头栏 `🔍`/`📑` 按钮。`PdfViewerHandle` 扩展 `toggleSearch/toggleSidebar/selectAll`。

**Tech Stack:** React 19 / TypeScript / Vite 6 / `pdfjs-dist@6.2.108`（已锁定）/ Playwright E2E

## Global Constraints

- `pdfjs-dist` 保持精确 `6.2.108`；worker/API 用法沿用一期（`render({ canvas, ... })`、`loadingTask.destroy()`）。
- 所有颜色来自 `tokens.css`；复用 `.kb-btn`/`.kb-btn-ghost`/`.kb-header-actions-divider`/`.kb-status-bar`/`.kb-content-area`。
- i18n 扁平 `kb.pdf.*` keys，`en.ts`+`zh.ts` 双语同步，`{param}` 插值。
- 内存纪律：卸载/切换取消 `RenderTask`、`loadingTask.destroy()`、忽略在途 promise（沿用一期）。
- `PdfPageView` 的 `hits` prop 必须稳定引用（父组件 `useMemo`），否则每次渲染重建文本层。
- 右键菜单 PDF 复制**只走纯文本**（`navigator.clipboard.writeText` + execCommand 回退），禁止 rich 三槽复制路径。
- `PdfViewerHandle` 顺序追加 `selectAll`（Task 3）、`toggleSearch`（Task 4）、`toggleSidebar`（Task 5），方法名精确一致。
- `data-testid` 契约（Task 6 E2E 依赖）：`pdf-searchbar`、`pdf-search-input`、`pdf-search-prev`、`pdf-search-next`、`pdf-search-close`、`pdf-search-count`、`kb-btn-pdf-search`、`kb-btn-pdf-sidebar`、`pdf-sidebar`、`pdf-sidebar-tab-outline`、`pdf-sidebar-tab-thumbs`、`pdf-outline-item`、`pdf-thumb`、`pdf-thumb-current`、`pdf-search-hl`、`pdf-search-hl-current`。
- 门禁：每任务 `cd apps/web && pnpm typecheck && pnpm build`；E2E 在 Task 6 全量回归。

---

### Task 1: area-map 注册 + fixture 扩展脚本（不含运行）

**Files:**
- Modify: `apps/web/e2e/area-map.json`
- Modify: `apps/web/scripts/generate-sample-pdf.mjs`（fixture 生成脚本扩展为 3 页 + 大纲 + 旋转页）

**Interfaces:**
- Consumes: 无。
- Produces: `generate-sample-pdf.mjs` 产出 3 页 PDF（页1 "Hello PDF - Page 1"、页2 "Hello PDF - Page 2"、页3 旋转文本 "Rotated Text Page 3"，含 2 条大纲指向页1/页2）。

- [ ] **Step 1: area-map 注册**

在 `apps/web/e2e/area-map.json` 顶层 `specs` 对象加一行（与其他 spec 同格式），并在 `areas.kb.specs` 数组追加 `"pdf-preview"`：

```json
  "specs": {
    ...,
    "pdf-preview": { "priority": "P1", "file": "pdf-preview.spec.ts" }
  }
```
```json
    "kb": {
      "paths": [ ... 不变 ... ],
      "specs": [ ..., "kb-large-file-too-large", "pdf-preview" ]
    }
```

- [ ] **Step 2: 扩展 fixture 生成脚本**

重写 `apps/web/scripts/generate-sample-pdf.mjs` 为 3 页 + 大纲 + 旋转页。对象布局：1 Catalog（含 `/Outlines 8 0 R`）、2 Pages、3/4 页1、5/6 页2、7 Font、8 Outlines、9/10 大纲项（Dest 指向页1/页2）、11/12 页3（旋转文本）。内容流：

```
// 页3 旋转文本（文本矩阵 Tm 带旋转 90°）
const content3 = 'BT /F1 24 Tf 0 1 -1 0 72 720 Tm (Rotated Text Page 3) Tj ET';
```

对象数组（索引即对象号）：
```js
const objects = [
  null, // 0 未用
  '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R 11 0 R] /Count 3 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>',
  '<< /Title (Page 1) /Parent 8 0 R /Dest [3 0 R /Fit] /Next 10 0 R >>',
  '<< /Title (Page 2) /Parent 8 0 R /Dest [5 0 R /Fit] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 12 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${content3.length} >>\nstream\n${content3}\nendstream`,
];
```
遍历对象 1..12 写 `xref 0 13`，`/Size 13`。其余逻辑（偏移计算、trailer）沿用一期脚本。`content1`/`content2` 保持一期内容。

- [ ] **Step 3: 生成并校验 fixture**

```bash
cd apps/web && node scripts/generate-sample-pdf.mjs
file e2e/fixtures/sample.pdf
# 期望：PDF document, version 1.4, 3 pages
```

- [ ] **Step 4: 门禁**

```bash
cd apps/web && pnpm typecheck && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/area-map.json apps/web/scripts/generate-sample-pdf.mjs apps/web/e2e/fixtures/sample.pdf
git commit -m "chore(web): 注册 pdf-preview E2E 到 area-map + fixture 扩展（大纲/旋转页）"
```

---

### Task 2: PdfPageView 抽出 + 文本层旋转对齐 + 首屏优化

**Files:**
- Create: `apps/web/src/components/kb/PdfPageView.tsx`
- Modify: `apps/web/src/components/kb/PdfViewer.tsx`

**Interfaces:**
- Consumes: `type PDFDocumentProxy` from `./pdfjs-setup`。
- Produces:
  - `export interface PdfSearchHit { itemIndex: number; fromInItem: number; toInItem: number; current: boolean }`（Task 4 使用）。
  - `export const PdfPageView = forwardRef<HTMLDivElement, { doc; pageNum; scale; hits?: PdfSearchHit[] }>`。
  - `PdfViewer.tsx` 删除内联 `PdfPageView`/`PageSlot`/`TextItemLike`，改 `import { PdfPageView } from './PdfPageView'`（`PageSlot` 保留在 PdfViewer）。

- [ ] **Step 1: 创建 PdfPageView.tsx**

```tsx
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
  function PdfPageView({ doc, pageNum, scale, hits = [] }, _ref) {
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
          if (!cancelled) console.error(`[PdfViewer] page ${pageNum} render failed`, err);
        }
      })();

      return () => {
        cancelled = true;
        renderTask?.cancel();
        const canvas = canvasRef.current;
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      };
    }, [doc, pageNum, scale, hits]);

    return (
      <>
        <canvas ref={canvasRef} data-testid={`pdf-canvas-${pageNum}`} />
        <div ref={textLayerRef} className="pdf-text-layer" data-testid={`pdf-text-layer-${pageNum}`} />
      </>
    );
  },
);
```

- [ ] **Step 2: PdfViewer 改用外部 PdfPageView**

`PdfViewer.tsx`：
- 删除内部 `PdfPageView`、`TextItemLike` 定义；`import { PdfPageView } from './PdfPageView';`（放在 `./pdfjs-setup` import 之后）。
- `PageSlot`、`RENDER_WINDOW` 等保留。
- `<PdfPageView doc={doc} pageNum={n} scale={scale} />` 调用不变（hits 参数 Task 4 再加）。

- [ ] **Step 3: 首屏优化（并行预取）**

`PdfViewer.tsx` load effect 中，把串行 `for` 循环改为：

```ts
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
```

- [ ] **Step 4: 门禁**

```bash
cd apps/web && pnpm typecheck && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/kb/PdfPageView.tsx apps/web/src/components/kb/PdfViewer.tsx
git commit -m "refactor(web): 抽出 PdfPageView，修文本层旋转对齐，并行预取首屏"
```

---

### Task 3: 选区闭环（PDF 右键菜单）

**Files:**
- Modify: `apps/web/src/components/kb/KbMainContent.tsx`
- Modify: `apps/web/src/components/kb/PdfViewer.tsx`（加 `selectAll` handle）
- Modify: `apps/web/src/i18n/locales/en.ts`、`zh.ts`（若新增 key）

**Interfaces:**
- Consumes: `PdfViewerHandle`（Task 3 为它加 `selectAll(): void`）。
- Produces: `PdfViewerHandle` 含 `selectAll`；KbMainContent 的 pdf 内容区右键菜单。

- [ ] **Step 1: PdfViewer 加 selectAll handle**

`PdfViewerHandle` 接口加 `selectAll: () => void;`。`PdfViewer` 内实现（选中**当前页**文本层全部文本）：

```ts
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
```
`useImperativeHandle` 的返回值加 `selectAll`，deps 加 `selectAll`。

- [ ] **Step 2: KbMainContent —— ctxMenu source 加 'pdf'**

第 168-170 行类型改为：

```ts
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; source: 'doocs' | 'codemirror' | 'pdf'; selectedText?: string } | null
  >(null);
```

新增 handler（`handleCmContextMenu` 附近）：

```ts
  const handlePdfContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, source: 'pdf' });
  }, []);
```

- [ ] **Step 3: pdf 内容区挂右键菜单**

PDF 渲染分支（`category === 'pdf' && vaultId ? (` 分支）的 `.kb-content-area.kb-pdf-area` 加 `onContextMenu={handlePdfContextMenu}`。

- [ ] **Step 4: 菜单项支持 pdf 源**

在菜单项构建（`ctxMenu && (` 内）加：

```ts
            const isPdfSource = ctxMenu.source === 'pdf';
            const sel = isCmSource ? (ctxMenu.selectedText ?? '') : selectionText();
            // PDF 文本层 span 透明 + transform：复制必须纯文本，禁止 rich HTML 三槽路径
            const selHtml = isCmSource || isPdfSource ? '' : (() => {
              /* 原 doocs 逻辑不变 */
            })();
            const selMd = (() => {
              if (!selHtml) return sel;
              /* 原逻辑不变 */
            })();
```

复制 onClick 保持现有结构（`if (!isCmSource && selHtml)` 对 pdf 因 `selHtml===''` 自然落到纯文本 `writeText`）。「选择全部」onClick 加 pdf 分支：

```ts
                onClick: () => {
                  if (isCmSource) { cmRef.current?.selectAll(); return; }
                  if (isPdfSource) { pdfRef.current?.selectAll(); return; }
                  const out = contentRef.current?.querySelector('#output');
                  /* 原 doocs 逻辑不变 */
                },
```

「问答选中内容」项对 pdf 无需改动（`onAskAboutSelection(sel)` 直接可用，sel 来自 `window.getSelection()`）。

- [ ] **Step 5: 门禁 + 手动冒烟**

```bash
cd apps/web && pnpm typecheck && pnpm build
# 手动：打开 PDF → 拖选文字 → 右键 → 断言出现 复制/选择全部/问答选中内容，复制后剪贴板为纯文本
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/kb/KbMainContent.tsx apps/web/src/components/kb/PdfViewer.tsx
git commit -m "feat(web): PDF 选区右键菜单 —— 复制纯文本/选择全部/问答选中内容"
```

---

### Task 4: 搜索高亮

**Files:**
- Create: `apps/web/src/components/kb/pdf-search.ts`
- Create: `apps/web/src/components/kb/PdfSearchBar.tsx`
- Modify: `apps/web/src/components/kb/PdfViewer.tsx`
- Modify: `apps/web/src/components/kb/KbMainContent.tsx`（头栏 `🔍` 按钮）
- Modify: `apps/web/src/i18n/locales/en.ts`、`zh.ts`
- Modify: `apps/web/src/components/kb/PdfViewer.css`

**Interfaces:**
- Consumes: `PdfSearchHit` from `./PdfPageView`；`buildPageText` 缓存。
- Produces:
  - `pdf-search.ts`: `PdfPageText`、`PdfMatch`、`buildPageText(page): Promise<PdfPageText>`、`findMatches(fullText, query): {start,end}[]`、`mapRangeToItems(pageText, start, end)`、`searchAll(doc, query, getText)`。
  - `PdfSearchBar.tsx`: `PdfSearchBar`（受控组件）。
  - `PdfViewerHandle` 加 `toggleSearch(): void`。

- [ ] **Step 1: 创建 pdf-search.ts**

```ts
import type { PDFDocumentProxy, PDFPageProxy } from './pdfjs-setup';

export interface PdfTextItem { str: string; transform: number[]; start: number; }
export interface PdfPageText { items: PdfTextItem[]; fullText: string; }
export interface PdfMatch { pageNum: number; itemIndex: number; fromInItem: number; toInItem: number; }

/** 构建单页文本索引：fullText 含 hasEOL 换行，item.start 记录字符起点。 */
export async function buildPageText(page: PDFPageProxy): Promise<PdfPageText> {
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  let fullText = '';
  for (const it of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
    if (!it.str) continue;
    items.push({ str: it.str, transform: it.transform ?? [1, 0, 0, 1, 0, 0], start: fullText.length });
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
    if (to > from) result.push({ itemIndex: i, fromInItem: from, toInItem: to });
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
```

> 注：`PDFPageProxy` 从 `pdfjs-dist` 导出；`pdfjs-setup.ts` 目前只 re-export `PDFDocumentProxy`，此处直接 `import type { PDFPageProxy } from 'pdfjs-dist'`（type-only，无 bundle 成本）。

- [ ] **Step 2: 创建 PdfSearchBar.tsx**

```tsx
import { useI18n } from '../../i18n';

interface PdfSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  total: number;
  activeIndex: number;
  searching: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function PdfSearchBar(props: PdfSearchBarProps) {
  const { t } = useI18n();
  const { query, onQueryChange, total, activeIndex, searching, onPrev, onNext, onClose } = props;
  const count = searching ? t('kb.pdf.searching')
    : total > 0 ? `${activeIndex + 1} / ${total}`
    : query.trim() ? t('kb.pdf.noMatches') : '';
  return (
    <div className="pdf-searchbar" data-testid="pdf-searchbar">
      <input
        data-testid="pdf-search-input"
        className="pdf-searchbar-input"
        type="text"
        value={query}
        placeholder={t('kb.pdf.searchPlaceholder')}
        onChange={(e) => onQueryChange(e.target.value)}
        autoFocus
      />
      <button type="button" className="kb-btn kb-btn-ghost" onClick={onPrev} data-testid="pdf-search-prev" title={t('kb.pdf.prevMatch')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button type="button" className="kb-btn kb-btn-ghost" onClick={onNext} data-testid="pdf-search-next" title={t('kb.pdf.nextMatch')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <span className="pdf-search-count" data-testid="pdf-search-count">{count}</span>
      <button type="button" className="kb-btn kb-btn-ghost" onClick={onClose} data-testid="pdf-search-close" title={t('kb.pdf.search')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 3: PdfViewer 集成搜索**

`PdfViewer.tsx` 增加状态与逻辑：

```ts
import { buildPageText, searchAll, type PdfMatch } from './pdf-search';
import { PdfSearchBar } from './PdfSearchBar';
import type { PdfSearchHit } from './PdfPageView';

const [searchVisible, setSearchVisible] = useState(false);
const [searchQuery, setSearchQuery] = useState('');
const [searching, setSearching] = useState(false);
const [matches, setMatches] = useState<PdfMatch[]>([]);
const [activeIndex, setActiveIndex] = useState(-1);
const textIndexRef = useRef<Map<number, Awaited<ReturnType<typeof buildPageText>>>>(new Map());

const getTextCached = useCallback(async (n: number) => {
  const cache = textIndexRef.current;
  let t = cache.get(n);
  if (!t) {
    const docNow = docRefNeeded(); // 见下
    const page = await docNow.getPage(n);
    t = await buildPageText(page);
    cache.set(n, t);
  }
  return t;
}, []);
```

> ⚠️ 上面 `docRefNeeded()` 是示意。**正确实现**：`getTextCached` 依赖 `doc` state（闭包捕获），把 `doc` 加入 deps：`useCallback(async (n) => { ... const page = await doc.getPage(n); ... }, [doc])`。同时 load effect 成功处 `textIndexRef.current.clear()`（切换文件清索引）。

```ts
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
    } finally {
      if (!cancelled) setSearching(false);
    }
  }, 300);
  return () => { cancelled = true; clearTimeout(timer); };
}, [searchQuery, doc, getTextCached, scrollToPage]);

const hitsByPage = useMemo(() => {
  const map = new Map<number, PdfSearchHit[]>();
  matches.forEach((m, i) => {
    const arr = map.get(m.pageNum) ?? [];
    arr.push({ itemIndex: m.itemIndex, fromInItem: m.fromInItem, toInItem: m.toInItem, current: i === activeIndex });
    map.set(m.pageNum, arr);
  });
  return map;
}, [matches, activeIndex]);
```

`PdfViewerHandle` 加 `toggleSearch: () => void`；`useImperativeHandle` 返回值加 `toggleSearch: () => setSearchVisible((v) => !v)`。

页面传递 `hits`：`<PdfPageView doc={doc} pageNum={n} scale={scale} hits={hitsByPage.get(n) ?? []} />`（`hitsByPage` 由 `useMemo` 保证稳定引用）。

渲染搜索条（scroll 容器上方、`status === 'ready'` 时）：
```tsx
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
```
搜索条在 `.pdf-viewer` 内、`.pdf-body` 之外（flex column 顶部）。

- [ ] **Step 4: 头栏 `🔍` 按钮 + i18n**

`KbMainContent.tsx` pdf 操作组内（fit 按钮之后）加：

```tsx
    <span className="kb-header-actions-divider" />
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.toggleSearch()}
      title={t('kb.pdf.search')}
      data-testid="kb-btn-pdf-search"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </button>
```

`zh.ts`/`en.ts` 追加（`kb.pdf.*` 区块内）：
```ts
'kb.pdf.search': '搜索',
'kb.pdf.searchPlaceholder': '在 PDF 中搜索',
'kb.pdf.prevMatch': '上一个匹配',
'kb.pdf.nextMatch': '下一个匹配',
'kb.pdf.searching': '搜索中…',
'kb.pdf.noMatches': '无匹配',
```
```ts
'kb.pdf.search': 'Search',
'kb.pdf.searchPlaceholder': 'Search in PDF',
'kb.pdf.prevMatch': 'Previous match',
'kb.pdf.nextMatch': 'Next match',
'kb.pdf.searching': 'Searching…',
'kb.pdf.noMatches': 'No matches',
```

- [ ] **Step 5: 样式**

`PdfViewer.css` 追加：

```css
.pdf-searchbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.pdf-searchbar-input {
  width: 220px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}

.pdf-searchbar-input:focus { border-color: var(--accent); }

.pdf-search-count {
  min-width: 48px;
  text-align: center;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text-muted);
}

/* 文本层搜索高亮（span 透明，仅高亮背景可见） */
.pdf-search-hl { background: var(--selected-soft); }
.pdf-search-hl-current { background: var(--accent-tint); outline: 1px solid var(--accent); outline-offset: -1px; }
```

- [ ] **Step 6: 门禁 + 手动冒烟**

```bash
cd apps/web && pnpm typecheck && pnpm build
# 手动：打开 PDF → 🔍 → 输入 "Hello" → 断言计数 2/2、高亮出现、下一匹配跳页
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/kb/pdf-search.ts apps/web/src/components/kb/PdfSearchBar.tsx apps/web/src/components/kb/PdfViewer.tsx apps/web/src/components/kb/KbMainContent.tsx apps/web/src/i18n/locales/en.ts apps/web/src/i18n/locales/zh.ts apps/web/src/components/kb/PdfViewer.css
git commit -m "feat(web): PDF 内搜索高亮 —— 索引/匹配/导航 + 搜索条"
```

---

### Task 5: 大纲/缩略图侧栏

**Files:**
- Create: `apps/web/src/components/kb/PdfSidebar.tsx`
- Modify: `apps/web/src/components/kb/PdfViewer.tsx`
- Modify: `apps/web/src/components/kb/KbMainContent.tsx`（头栏 `📑` 按钮）
- Modify: `apps/web/src/i18n/locales/en.ts`、`zh.ts`
- Modify: `apps/web/src/components/kb/PdfViewer.css`

**Interfaces:**
- Consumes: `PdfSearchHit` 无关；`doc`、`currentPage`、`scrollToPage`。
- Produces: `PdfSidebar`（受控组件）；`PdfViewerHandle` 加 `toggleSidebar(): void`。

- [ ] **Step 1: 创建 PdfSidebar.tsx**

```tsx
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
  const [tree, setTree] = useState<OutlineNode[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    doc.getOutline().then((o) => { if (!cancelled) setTree((o ?? []) as OutlineNode[]); }).catch(() => { if (!cancelled) setTree([]); });
    return () => { cancelled = true; };
  }, [doc]);
  if (tree === null) return <div className="pdf-sidebar-empty">…</div>;
  if (!tree.length) return <div className="pdf-sidebar-empty">{/* 空态文案走 t('kb.pdf.noOutline') 或复用 */}</div>;
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
```

- [ ] **Step 2: PdfViewer 集成侧栏**

`PdfViewer.tsx`：`const [sidebarOpen, setSidebarOpen] = useState(false);`；`PdfViewerHandle` 加 `toggleSidebar`；`useImperativeHandle` 加 `toggleSidebar: () => setSidebarOpen((v) => !v)`。

渲染结构改为（`status === 'ready'` 时主体）：

```tsx
        <div className="pdf-body">
          <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} onKeyDown={handleKeyDown} data-testid="pdf-scroll">
            <div className="pdf-scroll-inner" ref={contentRef}>
              {baseHeights.length ? pages : null}
            </div>
          </div>
          {sidebarOpen && doc && (
            <PdfSidebar doc={doc} currentPage={currentPage} onJumpToPage={scrollToPage} />
          )}
        </div>
```

`.pdf-body` 是新容器（flex row）；原 `.pdf-viewer` 为 flex column（搜索条 / body / 状态条）。overlay 仍绝对定位盖住整体。

- [ ] **Step 3: 头栏 `📑` 按钮 + i18n**

`KbMainContent.tsx` pdf 操作组（`🔍` 按钮之后）加：

```tsx
    <button
      type="button"
      className="kb-btn kb-btn-ghost"
      onClick={() => pdfRef.current?.toggleSidebar()}
      title={t('kb.pdf.sidebar')}
      data-testid="kb-btn-pdf-sidebar"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>
```

`zh.ts`/`en.ts` 追加：`'kb.pdf.sidebar': '侧栏'/'Sidebar'`、`'kb.pdf.outline': '大纲'/'Outline'`、`'kb.pdf.thumbnails': '缩略图'/'Thumbnails'`、`'kb.pdf.noOutline': '该 PDF 没有大纲'/'No outline for this PDF'`。

- [ ] **Step 4: 样式**

`PdfViewer.css` 追加：

```css
.pdf-body { flex: 1; display: flex; min-height: 0; position: relative; }

.pdf-sidebar {
  width: 230px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
}

.pdf-sidebar-tabs {
  display: flex;
  gap: 2px;
  padding: 6px;
  border-bottom: 1px solid var(--border);
}

.pdf-sidebar-tabs .kb-btn { flex: 1; height: 26px; font-size: 12px; }

.pdf-sidebar-scroll { flex: 1; overflow-y: auto; padding: 6px; }

.pdf-outline-item {
  display: block;
  width: 100%;
  padding: 5px 8px;
  border: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pdf-outline-item:hover { background: var(--bg-subtle); }

.pdf-thumbs { display: flex; flex-direction: column; gap: 8px; }

.pdf-thumb {
  border: 2px solid transparent;
  border-radius: var(--radius-sm);
  padding: 2px;
  cursor: pointer;
  background: #fff;
  box-shadow: var(--shadow-sm);
}

.pdf-thumb:hover { border-color: var(--border-strong); }

.pdf-thumb-current { border-color: var(--accent) !important; }

.pdf-thumb canvas { display: block; width: 100%; height: auto; }
```

- [ ] **Step 5: 门禁 + 手动冒烟**

```bash
cd apps/web && pnpm typecheck && pnpm build
# 手动：打开 PDF → 📑 → 大纲 tab 显示 Page 1/Page 2 → 点击跳页；缩略图 tab → 点击缩略图跳页、当前页描边
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/kb/PdfSidebar.tsx apps/web/src/components/kb/PdfViewer.tsx apps/web/src/components/kb/KbMainContent.tsx apps/web/src/i18n/locales/en.ts apps/web/src/i18n/locales/zh.ts apps/web/src/components/kb/PdfViewer.css
git commit -m "feat(web): PDF 大纲/缩略图侧栏 —— 右侧可折叠面板"
```

---

### Task 6: E2E 扩展 + 全量回归

**Files:**
- Modify: `apps/web/e2e/pdf-preview.spec.ts`
- Modify: `apps/web/scripts/generate-sample-pdf.mjs`（若 Task 1 后需要微调）

**Interfaces:**
- Consumes: Task 1 fixture（3 页 + 大纲 + 旋转页）、Task 3/4/5 的 `data-testid`。
- Produces: 覆盖选区复制 / 搜索 / 侧栏 / 旋转文本的 E2E。

- [ ] **Step 1: 选区复制 —— 拦截 clipboard 写入**

`pdf-preview.spec.ts` 顶部（describe 内）加一个稳定复制的辅助：用 `addInitScript` 拦截 `navigator.clipboard.writeText`：

```ts
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const writes: string[] = [];
      (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites = writes;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (text: string) => { writes.push(text); return Promise.resolve(); } },
        configurable: true,
      });
    });
  });
```

- [ ] **Step 2: 新增用例**

在现有 2 用例后追加：

```ts
  test('选区右键复制为纯文本', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    // 选中第 1 页文本层中的 "Page 1"
    await page.locator('[data-testid="pdf-text-layer-1"]').evaluate((el) => {
      const text = (el as HTMLElement).textContent ?? '';
      const idx = text.indexOf('Page 1');
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null; let startNode: Node | null = null; let startOff = 0; let endNode: Node | null = null; let endOff = 0; let acc = 0;
      while ((node = walker.nextNode())) {
        const len = (node as Text).length;
        if (!startNode && acc + len > idx) { startNode = node; startOff = idx - acc; }
        if (acc + len >= idx + 'Page 1'.length) { endNode = node; endOff = idx + 'Page 1'.length - acc; break; }
        acc += len;
      }
      if (startNode && endNode) {
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(range);
      }
    });
    // 在文本层上右键，点「复制」
    await page.locator('[data-testid="pdf-text-layer-1"]').click({ button: 'right', position: { x: 40, y: 40 } });
    await page.getByText('复制', { exact: true }).click();
    const writes = await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);
    expect(writes.join('\n')).toContain('Page 1');
  });

  test('搜索高亮与导航', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('kb-btn-pdf-search').click();
    const input = page.getByTestId('pdf-search-input');
    await input.fill('Hello');
    await expect(page.getByTestId('pdf-search-count')).toContainText('1 / 2', { timeout: 10_000 });
    await expect(page.locator('[data-testid="pdf-text-layer-1"] .pdf-search-hl')).toHaveCount(1);
    await page.getByTestId('pdf-search-next').click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 2 / 3');
    await expect(page.locator('[data-testid="pdf-text-layer-2"] .pdf-search-hl-current')).toHaveCount(1);
  });

  test('大纲与缩略图侧栏', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('kb-btn-pdf-sidebar').click();
    const sidebar = page.getByTestId('pdf-sidebar');
    await expect(sidebar).toBeVisible();
    // 大纲：fixture 有 Page 1 / Page 2 两条，点击 Page 2 跳到第 2 页
    await expect(sidebar.getByTestId('pdf-outline-item')).toHaveCount(2);
    await sidebar.getByTestId('pdf-outline-item').filter({ hasText: 'Page 2' }).click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 2 / 3');
    // 缩略图：切 tab → 点击第 3 张 → 跳到第 3 页
    await page.getByTestId('pdf-sidebar-tab-thumbs').click();
    await expect(sidebar.locator('canvas').first()).toBeVisible();
    await sidebar.locator('.pdf-thumb').nth(2).click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 3 / 3');
  });

  test('旋转文本文本层带 rotate', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="pdf-scroll"]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('[data-testid="pdf-text-layer-3"] span').first()).toBeVisible();
    const transform = await page.locator('[data-testid="pdf-text-layer-3"] span').first().evaluate((el) => (el as HTMLElement).style.transform);
    expect(transform).toContain('rotate(');
  });
```

> 搜索计数断言：fixture 页1/页2 各含一次 "Hello"，页3 旋转文本含 "Rotated Text Page 3"（无 Hello）→ "Hello" 2 匹配，初始 activeIndex=0 显示 `1 / 2`。

- [ ] **Step 3: 运行 PDF spec**

前置：daemon + web 在跑（若没起：`pnpm dev`）。如测试暴露真实 bug，按仓库规则修（组件优先，不弱化断言）。

```bash
cd apps/web && npx playwright test pdf-preview.spec.ts
# 期望：全部通过（原 2 用例 + 新 4 用例）
```

- [ ] **Step 4: 全量回归 + publish-flow**

```bash
cd apps/web && npx playwright test
# 期望：全绿（原 197 passed 之上只增不减；publish-flow 保持绿）
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/pdf-preview.spec.ts
git commit -m "test(web): PDF 二期 E2E —— 选区复制/搜索/侧栏/旋转文本"
```

---

## Self-Review 结果

- **Spec 覆盖**：选区闭环（T3）、搜索（T4）、侧栏（T5）、首屏优化（T2）、文本层旋转对齐（T2）、area-map（T1）、E2E（T6）——spec 全部目标有对应任务。密码输入/三期项未实现（spec 非目标）。
- **占位符扫描**：无 TBD/TODO。Task 4 Step 3 的 `docRefNeeded()` 示意已显式标注正确写法（闭包捕获 `doc` + 加 deps），避免照抄。Task 3 菜单项只给出增量片段，base 结构沿用一期既有代码（在 plan 中说明锚点）。
- **类型一致性**：`PdfSearchHit`（T2 定义 ↔ T4 使用）字段一致；`PdfViewerHandle` 方法 `selectAll`（T3）/`toggleSearch`（T4）/`toggleSidebar`（T5）在各任务与 `KbMainContent` 调用一致；`data-testid`（T3-T5 产出 ↔ T6 断言）一致；`kb.pdf.*` keys 各任务新增与使用一致。
