# Molio PDF 预览二期设计

日期：2026-08-04
状态：已确认（选区闭环 + 搜索 + 侧栏 + 首屏优化 + 文本层旋转对齐 + area-map 注册）
前置：`docs/2026-08-03-pdf-preview-design.md`（一期）已实现并评审通过

## 背景

一期实现了 PDF 内嵌预览（渲染 / 翻页 / 缩放 / 文字选择 / 状态条）。用户反馈：**「只有预览，功能没有闭环，选中复制这些需要有」**。

一期文本层已支持原生选择 / Ctrl+C，但**没有 Molio 自己的右键菜单**——文本文件（md/CM）已有的闭环（复制 / 选择全部 / 问答选中内容）在 PDF 上缺失。且原生复制 PDF 选区会带出文本层 span 的 inline transform / 透明样式，粘贴到富文本编辑器会错乱。

二期以**选区闭环**为最高优先级，补齐搜索、大纲/缩略图侧栏，并做两处质量优化。

## 范围

### 二期目标

1. **选区闭环（最高优先）**：PDF 页面区挂右键菜单——复制选中（纯文本）、选择全部（当前页）、问答选中内容（复用现有 `onAskAboutSelection`）；顺带修复文本层旋转/倾斜文字的对齐，保证旋转文字可正确选中。
2. **PDF 内搜索高亮**：头栏 `🔍` 唤起搜索条，全文查找 + 匹配高亮 + 上一/下一导航 + 计数。
3. **大纲/缩略图侧栏**：头栏 `📑` 唤起右侧可折叠面板，[大纲 | 缩略图] 双 tab，点击跳页。
4. **首屏优化**：串行 `getPage` 预取改为并行。
5. **area-map 注册**：`pdf-preview` 加入 `apps/web/e2e/area-map.json`（kb area + 顶层 specs 表），否则 PR 的 affected-E2E 不会跑 PDF 用例。

### 非目标（延后/另行评估）

- **密码输入**（用户确认延后）：加密 PDF 保持一期提示 + 外部打开；应用内输密码后续再做。
- 标注/高亮与笔记联动、`![[file.pdf]]` markdown 内嵌、阅读位置记忆（三期）。

## 1. 选区闭环

### 右键菜单（KbMainContent 侧）

- 新增 `handlePdfContextMenu`：`setCtxMenu({ x, y, source: 'pdf' })`（复用现有 `ContextMenu` / `ctxMenu` state）。
- PDF 渲染分支的内容区（`.kb-content-area.kb-pdf-area`）挂 `onContextMenu={handlePdfContextMenu}`。
- 菜单项构建逻辑增加 `isPdfSource` 分支：
  - **复制**：**纯文本** `navigator.clipboard.writeText(sel)`（带 `document.execCommand('copy')` 回退）。**不走** doocs 的 rich 三槽复制（`ClipboardItem` text/html）——PDF 文本层 span 是透明 + transform，rich HTML 会把样式带出去。
  - **选择全部**：选中**当前页**文本层全部内容（`document.createRange()` 选中当前 `.pdf-text-layer` 的 span 文本）。跨页全选不做。
  - **问答选中内容**：`sel.length <= MAX_ASK_SELECTION` 时 `onAskAboutSelection(sel)`（现有链路，KnowledgeBasePage 已接 `handleAskAboutSelection`）。
- 选区读取 `selectionText()`（`window.getSelection().toString().trim()`）——PDF 文本层是真实 DOM 文本，直接可用。

### 文本层旋转对齐（PdfPageView 侧）

一期文本层用 `translate(e*scale, f*scale)` + `fontSize = hypot(a,b)*scale`，忽略 `c/d`（旋转/倾斜）分量，旋转文字错位。修正为标准 pdf.js 文本层做法：

- 组合 viewport 变换与 item 变换：`[a,b,c,d,e,f] = viewport.transform ∘ item.transform`。
- `angle = atan2(b, a)`；`fontSize = hypot(a,b)`；`scaleY = hypot(c,d) / fontSize`。
- span：`transform: translate(e px, f px) rotate(angle rad) scaleY(scaleY)`，`transform-origin: 0 0`，`fontSize` 用缩放后值。

这同时保证搜索高亮 mark 与选中区域对齐。

## 2. 搜索高亮

### 交互

- 头栏 `🔍`（经 `PdfViewerHandle.toggleSearch()`）→ 查看器内**页面区顶部 sticky 搜索条**：
  ```
  [输入框]  [↑ 上一] [↓ 下一]  3 / 12  [✕]
  ```
- 输入即搜（300ms debounce，Enter 立即触发）；空查询清除高亮。搜索中显示「搜索中…」。

### 纯逻辑模块 `pdf-search.ts`

- `buildPageText(page)`：调 `page.getTextContent()`，按 item 拼接 `fullText`（`str` + (`hasEOL` ? `'\n'` : '')），记录每 item 的字符起点 → `{ items: { str, transform, start }[], fullText }`。
- `findMatches(pageText, query)`：大小写不敏感子串查找 → `[{ start, end }]`。
- `mapRangeToItems(pageText, range)`：把 `[start,end)` 映射回其覆盖的 `[{ itemIndex, fromInItem, toInItem }]`（匹配可跨 item）。
- `searchAll(doc, query)`：异步逐页扫描（可取消），返回 `{ pageNum, itemIndex, fromInItem, toInItem }[]`。

### 高亮与导航

- `PdfViewer` 持搜索状态：`query` / `matches` / `activeIndex` / `searching` / `visible`。
- `PdfPageView` 新增 `hits?: { itemIndex, fromInItem, toInItem, current }[]` prop；构建文本层时把命中段包进 `<mark class="pdf-search-hl">`，当前匹配加 `pdf-search-hl-current`。effect deps 加 `hits`，查询变化时重建文本层。
- 上一/下一匹配 → `scrollToPage(match.pageNum)` + 更新 `activeIndex`。
- 文本索引按 `doc` 缓存（ref），切换文件清除。

## 3. 大纲/缩略图侧栏

### 交互

- 头栏 `📑`（经 `PdfViewerHandle.toggleSidebar()`）→ 右侧 ~230px 可折叠面板（flex 行：页面区 + 侧栏）。
- 面板顶部 `[大纲 | 缩略图]` 双 tab。
- **大纲**：`doc.getOutline()` 嵌套树（缩进），点击 → 解析 dest → 跳页。
- **缩略图**：mini canvas 列表，`IntersectionObserver` 进入视口才渲染；当前页高亮 + 自动滚入视口；点击跳页。

### dest 解析

```
async function destToPageNum(doc, dest): Promise<number | null> {
  if (typeof dest === 'string') dest = await doc.getDestination(dest); // 命名目的地
  if (!Array.isArray(dest) || !dest.length) return null;
  const ref = dest[0];
  const pageIndex = await doc.getPageIndex(ref);
  return pageIndex + 1;
}
```

## 4. 首屏优化

一期 load effect 串行 `for` 循环 `getPage` 预取高度 → 改为 `Promise.all(Array.from({ length: numPages }, (_, i) => pdfDoc.getPage(i + 1)))`，随后一次性算高度。

## 5. area-map 注册

`apps/web/e2e/area-map.json`：
- 顶层 `specs`：`"pdf-preview": { "priority": "P1", "file": "pdf-preview.spec.ts" }`。
- `areas.kb.specs`：追加 `"pdf-preview"`。

## 文件拆分

一期 `PdfViewer.tsx`（380 行）将承载搜索/侧栏 → 按职责拆：

| 文件 | 职责 |
|---|---|
| `apps/web/src/components/kb/PdfViewer.tsx` | 编排：doc 生命周期、滚动/缩放/窗口/状态条、搜索状态、侧栏开关 |
| `apps/web/src/components/kb/PdfPageView.tsx` | 单页 canvas + 文本层（旋转对齐 + 搜索高亮 mark），从 PdfViewer 抽出 |
| `apps/web/src/components/kb/pdf-search.ts` | 纯搜索逻辑：`buildPageText` / `findMatches` / `mapRangeToItems` / `searchAll` |
| `apps/web/src/components/kb/PdfSearchBar.tsx` | 搜索条 UI（输入 / 上一 / 下一 / 计数 / 关闭） |
| `apps/web/src/components/kb/PdfSidebar.tsx` | 侧栏容器 + 大纲树 + 缩略图列表（同文件内子组件） |
| `apps/web/src/components/kb/PdfViewer.css` | 追加搜索条 / 侧栏 / 高亮 / 选区样式（全 token） |
| `apps/web/src/components/kb/KbMainContent.tsx` | 右键菜单 pdf 分支 + 头栏 `🔍`/`📑` 按钮 + `PdfViewerHandle` 扩展 |
| `apps/web/e2e/area-map.json` | 注册 pdf-preview |

`PdfViewerHandle` 增加 `toggleSearch(): void` / `toggleSidebar(): void`。

## 样式（追加到 PdfViewer.css，仍全 token）

- 搜索条：`.pdf-searchbar`，sticky top，`--bg-panel` + `--border`，输入框 26px 圆角；高亮 `<mark class="pdf-search-hl">` 用 `--selected-soft` 背景，当前匹配 `--accent-tint` + `--accent` 边框。
- 侧栏：`.pdf-sidebar`，`--bg-panel` + 左边框 `--border`；tab 复用 `.kb-btn.kb-btn-ghost` 风格。
- 大纲树缩进 + 悬停 `--bg-subtle`；缩略图当前页描边 `--accent`。
- 选区 `::selection` 保持一期 `--selected-soft`。

## 测试

**E2E**（扩展 `apps/web/e2e/pdf-preview.spec.ts`）：

- 现有 2 用例保留。
- **选区**：文本层拖选「Page 1」→ 右键 → 复制 → `context.grantPermissions(['clipboard-read','clipboard-write'])` 后断言剪贴板纯文本；问答选中内容项在菜单中存在（触发需 agent，标注为可选断言）。
- **搜索**：输入 "Hello" → 计数 2/2 → 下一匹配跳第 2 页 → 高亮元素存在（`pdf-search-hl`）。
- **侧栏**：点 `📑` → 面板可见 → 大纲 tab 显示 → 点击大纲项跳页；缩略图 tab → 点击缩略图跳页。
- **旋转文本**（可选）：fixture 加一个旋转文本页，断言文本层 span 带 `rotate(`。

fixture `sample.pdf` 需扩展（当前 2 页纯横向文本）——新增一个带旋转文本的页或生成第二个 fixture。

回归：`publish-flow` + 全量。

## 改动文件清单

| 文件 | 动作 |
|---|---|
| `apps/web/src/components/kb/PdfPageView.tsx` | **新增**（自 PdfViewer 抽出 + 旋转对齐 + 搜索高亮） |
| `apps/web/src/components/kb/pdf-search.ts` | **新增**（纯逻辑） |
| `apps/web/src/components/kb/PdfSearchBar.tsx` | **新增** |
| `apps/web/src/components/kb/PdfSidebar.tsx` | **新增** |
| `apps/web/src/components/kb/PdfViewer.tsx` | 重构：抽出 PdfPageView，加搜索/侧栏状态与 handle 扩展 |
| `apps/web/src/components/kb/PdfViewer.css` | 追加样式 |
| `apps/web/src/components/kb/KbMainContent.tsx` | 右键菜单 pdf 分支 + 头栏 `🔍`/`📑` 按钮 |
| `apps/web/e2e/area-map.json` | 注册 pdf-preview |
| `apps/web/e2e/pdf-preview.spec.ts` | 扩展用例 |
| `apps/web/scripts/generate-sample-pdf.mjs` + fixture | 扩展（旋转文本页） |
