# Molio PDF 预览设计

日期：2026-08-03
状态：已确认（架构 + 组件/样式）
分支：`feat/pdf-preview`

## 背景

Molio 当前不支持 PDF 预览。知识库中点击 `.pdf` 文件只会显示一个文件信息卡片，Electron 下提供一个「用外部程序打开」按钮；纯 Web（Docker/NAS 自建）场景则无任何打开途径。而 PDF 是知识管理场景中常见的阅读对象（书籍、论文、报告），非技术用户预期在应用内直接阅读。

## Obsidian 的实现（调研结论）

- Obsidian 内置查看器 = **定制版 Mozilla PDF.js**（`lib/pdfjs/pdf.viewer.min.js`）。
- 渲染链路：`pdfjsLib.getDocument()` 异步加载 → `page.getViewport({ scale })` → `page.render()` 绘制到 HTML canvas；上方叠加透明**文本层**（`getTextContent()`），用 `--scale-factor` CSS 变量对齐，实现选择 / 复制 / 搜索高亮。
- HiDPI：根据 `window.devicePixelRatio` 计算渲染 scale，Retina 不模糊。
- 用户功能：分页、缩放、搜索、大纲/缩略图侧栏、文字选择。
- 笔记内嵌：`![[file.pdf#page=3]]`。
- 标注 / 与笔记联动：由社区插件（PDF++、Study PDF）扩展，非内置。

## 现状（Molio 侧）

后端**已就绪，零改动**：

- `GET /api/knowledge/vaults/:id/raw/*`（`apps/daemon/src/routes/knowledge.ts:301-356`）已返回 `application/pdf`，支持 `Accept-Ranges: bytes` 与 Range/206 分段——pdf.js 按需加载所需能力齐备。
- `.pdf` 已在 `ALLOWED_EXTS`（`apps/daemon/src/core/knowledge.ts:542`），文件树可见；导入校验已放行（`KbModals.tsx:265,383`）。
- `FileContent.mimeType` 后端已填充但前端从未读取。

缺口仅在 **web 前端渲染层**：`apps/web/src/components/kb/KbMainContent.tsx` 中 `.pdf` 落入 `'binary'` 分类（`getFileCategory`，第 62-70 行），渲染为文件信息卡片（第 735-751 行）。

## 目标与非目标

### 目标（一期）

1. 知识库文件树点击 PDF → 主内容区**内嵌预览**，替换 binary 卡片。
2. 对话中引用文件（`FileRef.tsx` chip）点击 → 与其他文件一致的跳转交互（现有 `useFileNavigation` 链路，无需改动）。
3. 查看器支持：翻页、缩放、适合宽度/适合页面、页码跳转、**文字选择/复制**、阅读状态显示（页码 + 缩放比）。
4. 与 Molio 设计语言完全一致（亮/暗色 token、头栏按钮、底部状态条）。
5. 后端零改动。

### 非目标（二期/三期另行评估）

- PDF 内搜索高亮、大纲/缩略图侧栏（二期）。
- 密码输入交互（一期仅提示）。
- 标注/高亮与笔记联动、`![[file.pdf]]` markdown 内嵌、阅读位置记忆（三期）。

## 技术方案

**方案 A（已确认）：自定义 React 查看器，底层 `pdfjs-dist`**，与 Obsidian 同源。不引入 react-pdf 等中间层（控制力更强、版本问题更少）。

### 依赖与构建

| 项 | 做法 |
|---|---|
| 依赖 | `apps/web/package.json` 加 `pdfjs-dist`（**锁定精确版本**，保证 API 与 worker 版本一致）；`vite-plugin-static-copy`（devDep）用于拷贝 cmaps |
| Worker | `import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` → `GlobalWorkerOptions.workerSrc`。`?url` 让 Vite 构建期把 worker 当资产处理，pnpm 下最稳。若此路径有坑，回退 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` |
| CJK cmaps | `getDocument({ cMapUrl, cMapPacked: true })`；`viteStaticCopy` 把 `node_modules/pdfjs-dist/cmaps/` 拷入构建产物，路径加 `import.meta.env.BASE_URL` 前缀，保证 dev / Electron / Docker 部署均可解析 |
| 懒加载 | `pdfjs-dist` 通过 `PdfViewer` 组件内**动态 `import()`**，仅打开 PDF 时进入 bundle，不拖慢首屏 |

### 架构

```
KbMainContent.tsx
  │  getFileCategory() 新增 'pdf' 分类（在 binary 之前判断）
  │  渲染分支 category === 'pdf'：
  │    <div class="kb-content-area kb-pdf-area">   ← flex 列布局，overflow hidden，padding 0
  │      <PdfViewer url={api.rawFileUrl(vaultId, selectedFile)}
  │                 fileName={fileName} onOpenExternal={isElectron ? handleOpenExternal : undefined} />
  │    头栏新增 pdf 操作组（‹ / › / − / + / 适合宽度 / 适合页面）
  └──────────────────────────────────────────────
```

- **头栏操作组**：复用 `.kb-btn.kb-btn-ghost`（15px feather 内联 SVG，与 `KbMainContent.tsx:470-527` 文本文件操作一致）。通过 `pdfRef`（`useImperativeHandle`）命令式调用 `PdfViewer` 的 `prevPage / nextPage / zoomIn / zoomOut / fitWidth / fitPage`——与 `KbCodeMirrorViewer` 暴露 `cmRef.gotoLine()` 的模式一致。
- **「用外部程序打开」**：头栏已有按钮（`category === 'binary'` 分支，`:530-539`），把条件扩为 `binary || pdf` 复用，不重复实现。
- **状态读数**：页码/缩放放查看器**内部底部状态条**（非头栏），避免把 viewer 内部状态上提到父组件。`PdfViewer` 保持自包含。

### 组件结构（`apps/web/src/components/kb/PdfViewer.tsx`）

```tsx
PdfViewer({ url, fileName, onOpenExternal? })
├── <div class="pdf-scroll" ref={scrollRef}>        // flex:1; overflow-y:auto; background: var(--bg)
│   ├── <div class="pdf-page">（每页一个，懒渲染窗口内）// 白底 + var(--shadow-md)，居中，margin 0 auto 24px
│   │   ├── <canvas>
│   │   └── <div class="pdf-text-layer">            // 文本层，--scale-factor 对齐
├── <div class="pdf-statusbar">                     // 第 003 / 247 页 · 120%
└── loading overlay / error card
```

内部状态：`pdfDoc`、`pageCount`、`currentPage`、`scale`、`status('loading'|'ready'|'error')`、`error`。

### 渲染策略

- **懒渲染**：滚动驱动的渲染窗口（可见页 ±2 页）。滚动时计算可见区间，`page.getPage(n)` → `getViewport({ scale })` → `page.render()` 绘制到 canvas，同页叠加文本层（`getTextContent()` 手动构建 span + `--scale-factor`）。离开窗口的页面取消渲染并释放 canvas，适配数百页大 PDF。
- **缩放**：`scale` 状态驱动。缩放时先 `RenderTask.cancel()` 清空在途渲染再重绘；文本层同步重建。
- **初始模式**：适合宽度（按容器宽度算首屏 scale）。
- **文字选择**：文本层透明，选区高亮用 Molio `--selected-soft` token。
- **内存清理（强制，对齐仓库近期 leak 修复规范）**：组件卸载 / 文件切换 / 错误时 `pdfDoc.destroy()` + 取消全部 `RenderTask` 与在途 promise，防止 canvas / worker / listener 泄漏。

### 错误处理与边界

| 场景 | 表现 |
|---|---|
| 文件损坏 / 无效 PDF（`InvalidPDFException`） | 错误卡片：「这个 PDF 文件已损坏或格式无效，无法预览。」+ 重试 + 外部打开（Electron） |
| 加密 PDF（`PasswordException`） | 「这个 PDF 已加密，暂时无法预览。可以试试用外部程序打开。」+ 重试（密码输入二期） |
| 加载失败 / 404 | 「PDF 加载失败」+ 重试 / 外部打开兜底 |
| 超大 PDF | 懒渲染天然支持，不设硬上限 |

错误文案遵循「错误即指引」：说明发生了什么 + 如何解决，不道歉不模糊。复用外层 `ViewerErrorBoundary` 包裹懒加载。

### i18n

`apps/web/src/i18n/locales/{en,zh}.ts` 新增 `kb.pdf.*` 扁平 keys（`nextPage / prevPage / zoomIn / zoomOut / fitWidth / fitPage / pageIndicator / pageOf / passwordProtected / invalidFile / loadFailed / openExternal(复用现有) / retry` 等），双语同步。

## 样式设计（`apps/web/src/components/kb/PdfViewer.css`）

全部走 `tokens.css` 变量，**不引入新色/新字体**。设计判断：查看器是「暖色桌面上的文档」，不是浏览器默认 UI。

| 元素 | 做法 |
|---|---|
| 页面区背景 | `var(--bg)`；页面白底 `#fff` + `var(--shadow-md)`，暗色模式下白纸自然突出 |
| 页面 | `margin: 0 auto 24px`，适合宽度/适合页面时居中；`box-sizing: border-box` 精确对齐 |
| 文本层 | `position: absolute; inset: 0; overflow: hidden; line-height: 1`；`::selection` 用 `--selected-soft` |
| 底部状态条 | 复用 `.kb-status-bar` 视觉（`border-top` / `--bg-subtle` / 14px / `--text-muted`）——注意 `.kb-status-bar` 只在 `category === 'text'` 渲染，PDF 自带不重复 |
| 页码读数 | `--mono` + 定宽数字（`第 003 / 247 页 · 120%`）：页码变化不跳动（功能） + 仪器面板式精确感（signature，用现有 token） |
| 头栏按钮 | 复用 `.kb-btn.kb-btn-ghost`，**零新按钮样式** |
| 分隔 | 复用 `.kb-header-actions-divider` |
| 图标 | 头栏 15px feather 内联 SVG（与现有 KB 图标同风格） |
| 状态条分隔 | 复用 `.kb-header-actions-divider` 样式 |

### 刻意不做（克制）

- 缩放档位下拉菜单（− / + / 适合宽度 / 适合页面已够用）
- 页面镀铬 / 装饰性边框
- 悬浮翻页 pill（状态条已承担读数）
- 动画 / 过渡（尊重 `prefers-reduced-motion`，查看器保持安静）

## 测试

**E2E**（web 无单元测试框架，测试全走 Playwright）：

- 新增 `apps/web/e2e/pdf-preview.spec.ts`，声明 `@area kb` / `@priority P1`（改动命中 kb 时跑）。
- fixture：提交一个约 2 页、**带文本层**的小 PDF（`apps/web/e2e/fixtures/sample.pdf`），测试中用 `createTempVault`（`e2e/helpers/cleanup.ts`）建临时 vault 并把 fixture 拷入。
- 用例：
  1. 文件树点击 `.pdf` → 查看器出现（`data-testid="pdf-viewer"`）
  2. 首页 canvas 渲染（`data-testid="pdf-canvas-N"` 存在且非空）
  3. 文本层存在（`pdf-text-layer` 有 span）
  4. 页码读数正确（`第 1 / N 页`）
  5. 下一页 / 缩放按钮生效（页码变化 / canvas 尺寸变化）
- 回归：`apps/web/e2e/publish-flow.spec.ts`（CLAUDE.md 强制：改 `src/components/kb/` 必须同步并全绿）。
- 选择器优先级：`data-testid` > CSS class > 文本。

## 改动文件清单

| 文件 | 动作 |
|---|---|
| `apps/web/package.json` | + `pdfjs-dist`（精确版本）+ `vite-plugin-static-copy` |
| `apps/web/vite.config.ts` | worker `?url` 内联处理；`viteStaticCopy` 拷贝 `pdfjs-dist/cmaps/` |
| `apps/web/src/components/kb/PdfViewer.tsx` | **新增**：查看器核心组件（`forwardRef` + `useImperativeHandle`） |
| `apps/web/src/components/kb/PdfViewer.css` | **新增**：样式（全 token） |
| `apps/web/src/components/kb/KbMainContent.tsx` | `getFileCategory` 加 `pdf` 分类；渲染分支；头栏 pdf 操作组 + `openExternal` 条件扩为 `binary \|\| pdf` |
| `apps/web/src/i18n/locales/en.ts`、`zh.ts` | + `kb.pdf.*` keys |
| `apps/web/e2e/pdf-preview.spec.ts` | **新增** E2E |
| `apps/web/e2e/fixtures/sample.pdf` | **新增** fixture（~2 页带文本层） |
| daemon | 无改动 |

## 实施阶段

- **一期（本 spec）**：核心查看器（渲染 / 翻页 / 缩放 / 适合宽度·页面 / 文字选择 / 状态条 / 错误处理）+ 头栏操作组 + E2E。
- **二期**：搜索高亮、大纲/缩略图侧栏、密码输入。
- **三期**：`![[file.pdf]]` 内嵌、标注联动、阅读位置记忆。
