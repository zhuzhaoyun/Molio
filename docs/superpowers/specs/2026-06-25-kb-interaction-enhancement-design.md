# KB Interaction Enhancement — Design Spec

**Date**: 2026-06-25  
**Branch**: `feat/kb-interaction-enhancement`  
**Status**: Design ✅

## Overview

KB 页面交互全面升级：全局"更多选项"菜单、文档统计 Status Bar、文档大纲面板、折叠全部文件夹、全文搜索。补足与 Obsidian 的交互差距，发挥 Molio AI-Native 差异化优势。

## Motivation

对比 Obsidian，Molio KB 页面缺少三个关键交互：
1. **统一的"更多选项"入口** — 当前功能按钮平铺在工具栏，无溢出菜单，新用户发现功能困难
2. **文档元信息展示** — 无字数/字符统计，写作场景下的基本需求未满足
3. **长文档导航** — 无大纲/目录，长文档内跳转困难

## Design Philosophy

**Obsidian 是文件中心，Molio 是 AI-Native。** 借用 Obsidian 的交互范式（菜单、大纲、统计），但不复制其文件管理逻辑。差异化体现在菜单中的 AI 动作（Phase 3）和基于 wiki embedding 的相关文件推荐。

## Implementation Phases

| Phase | 内容 | 依赖 |
|-------|------|------|
| Phase 1 | `···` 菜单 + 文档统计 + 大纲面板 + 折叠文件夹 | 纯前端，无后端 |
| Phase 2 | 全文搜索 | daemon 新增轻量搜索端点 |
| Phase 3 | AI 摘要/要点/相关文件 | wiki embedding 接口 |

**本次交付 Phase 1 + Phase 2**，Phase 3 后续迭代。

---

## 1. `···` 全局菜单 (Phase 1)

### 位置

`KnowledgeBasePage` 右上角，`KbMainContent` header 区域，始终可见。不依赖文件是否打开。

### 菜单结构

```
···
├── 📋 文档大纲           ← Phase 1, 打开 OutlinePanel
├── 📊 文档统计           ← Phase 1, 滚动到 status bar
├── 🔍 全文搜索           ← Phase 2, 打开 SearchPanel
├── 📂 折叠全部文件夹      ← Phase 1, 触 collapseAll
├── ─────────────
├── 🤖 AI 生成摘要        ← Phase 3, disabled + "即将上线"
├── 🤖 AI 提取要点        ← Phase 3, disabled + "即将上线"
└── 🤖 查找相关文件        ← Phase 3, disabled + "即将上线"
```

### 交互

- 点击 `···` → 下拉菜单展开（左对齐，向下）
- 点击菜单项 → 关闭菜单，执行对应动作
- 点击外部 / ESC → 关闭
- Phase 3 项置灰 + tooltip "即将上线"

### 组件

```typescript
interface KbMoreMenuProps {
  onOpenOutline: () => void;
  onOpenSearch: () => void;
  onCollapseAll: () => void;
}
```

### 新增文件

| File | Purpose |
|------|---------|
| `apps/web/src/components/kb/KbMoreMenu.tsx` | 菜单组件 |
| `apps/web/src/components/kb/KbMoreMenu.css` | 菜单样式 |

### 修改文件

| File | Change |
|------|--------|
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | 集成 KbMoreMenu，管理 outline/search 面板状态 |

---

## 2. 文档统计 Status Bar (Phase 1)

### 位置

`KbMainContent` 底部，文档内容和容器底边之间。

### 显示

```
字数: 1,234  /  字符: 5,678  /  阅读时间: ~5分钟
```

- **字数**：CJK 字符统计（Unicode range `一-鿿` `㐀-䶿` + 空格分词英文单词）+ 英文词数
- **字符数**：`content.length`
- **阅读时间**：`ceil(字数 / 300)` 分钟（中文平均 300 字/分钟）
- 无文件时不显示
- 样式：14px，`var(--text-muted)`，右对齐

### 实现

纯前端计算，在 `KbMainContent` 中新增 `<div className="kb-status-bar">`。

### 修改文件

| File | Change |
|------|--------|
| `apps/web/src/components/kb/KbMainContent.tsx` | 新增 status bar 渲染 |
| `apps/web/src/styles/knowledge.css` | `.kb-status-bar` 样式 |

---

## 3. 文档大纲面板 (Phase 1)

### 触发

点击菜单「文档大纲」→ 右侧滑出面板

### 内容

解析当前 markdown 内容的 `##` 和 `###` 标题：

```
📋 文档大纲
─────────────────
  设计目标
    性能要求
    兼容性
  实现方案
    方案 A：增量迁移
    方案 B：全量重写
  测试策略
─────────────────
```

- H2 缩进 0，H3 缩进 1 级
- 点击标题 → 文档滚动到对应位置（通过 `id` 或标题文本查找）
- 当前可视区域标题高亮
- 空文档或无标题 → "暂无标题"

### 组件

```typescript
interface OutlinePanelProps {
  content: string;
  onClose: () => void;
}
```

### 新增文件

| File | Purpose |
|------|---------|
| `apps/web/src/components/kb/OutlinePanel.tsx` | 大纲面板组件 |
| `apps/web/src/components/kb/OutlinePanel.css` | 大纲样式 |

### 修改文件

| File | Change |
|------|--------|
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | 管理大纲面板显示/隐藏状态 |

---

## 4. 折叠全部文件夹 (Phase 1)

### 触发

点击菜单「折叠全部文件夹」

### 实现

`KbFileTree` 组件通过 `collapseAllCounter` prop（或 ref）接收折叠信号，将所有展开的目录折叠。

### 修改文件

| File | Change |
|------|--------|
| `apps/web/src/components/kb/KbFileTree.tsx` | 新增 `collapseAll` 逻辑（递增 counter 触发重置） |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | 传递 collapseAll 信号 |

---

## 5. 全文搜索 (Phase 2)

### 入口

- 菜单「全文搜索」
- 快捷键 `Ctrl/Cmd+F`（在 KB 页面时拦截）

### UI

```
┌─────────────────────────────────────────────┐
│ 🔍 [____输入关键词________________________]  │
│─────────────────────────────────────────────│
│ 📄 设计文档.md                               │
│    ...讨论了微服务拆分的**三种方案**...         │  ← 高亮匹配词
│                                              │
│ 📄 架构评审.md                               │
│    ...服务拆分采用**领域**驱动...              │
│                                              │
│ 📄 notes/技术选型.md                         │
│    ...微服务框架选型**对比分析**...             │
└─────────────────────────────────────────────┘
```

- 输入关键词 → debounce 300ms → 搜索
- 结果：文件名 + 匹配片段（关键词前后 30 字符），高亮匹配
- 点击结果 → KB 中打开该文件
- 搜索结果上限 20 条

### Daemon API

```
GET /api/knowledge/vaults/:id/search?q=关键词&limit=20
Response: {
  results: [{ filePath, fileName, snippet }]
}
```

- 遍历 vault 目录 `fs.readdirSync`，过滤 `.md/.txt`
- 每个文件 `fs.readFileSync`，`String.includes` 匹配
- 找到匹配后截取前后 30 字符作为 snippet
- 500 文件以内毫秒级完成

### 组件

```typescript
interface SearchPanelProps {
  vaultId: string;
  onOpenFile: (filePath: string) => void;
  onClose: () => void;
}
```

### 新增文件

| File | Purpose |
|------|---------|
| `apps/web/src/components/kb/SearchPanel.tsx` | 搜索面板 |
| `apps/web/src/components/kb/SearchPanel.css` | 搜索样式 |

### 修改文件

| File | Change |
|------|--------|
| `apps/daemon/src/routes/knowledge.ts` | 新增 `GET /vaults/:id/search` 路由 |
| `apps/web/src/api/client.ts` | 新增 `searchFiles(vaultId, query)` |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | 管理搜索面板状态，监听 Ctrl+F |
| `apps/web/src/styles/knowledge.css` | 搜索面板样式 |

---

## Component Dependency Graph

```
KnowledgeBasePage
    ├── KbMoreMenu ···──────────────────── 全局菜单入口（新增 Phase 1）
    │       ├── → 打开 OutlinePanel（新增 Phase 1）
    │       ├── → 打开 SearchPanel（新增 Phase 2）
    │       ├── → collapseAll()（新增 Phase 1）
    │       ├── → AI 摘要（Phase 3, disabled）
    │       ├── → AI 提取要点（Phase 3, disabled）
    │       └── → AI 查找相关文件（Phase 3, disabled）
    │
    ├── KbMainContent
    │       ├── kb-header-actions（已有工具栏）
    │       └── kb-status-bar（新增 Phase 1）：字数 / 字符 / 阅读时间
    │
    ├── KbFilePanel
    │       └── KbFileTree ── collapseAll（新增 Phase 1）
    │
    ├── OutlinePanel（新增 Phase 1，右侧滑出）
    └── SearchPanel（新增 Phase 2，浮层）
```

---

## Data Flow

### 大纲面板

```
KbMoreMenu.onOpenOutline()
    → KnowledgeBasePage: setShowOutline(true)
    → OutlinePanel renders
    → 解析 selectedFile.content: /^#{2,3}\s+(.+)$/gm
    → 渲染目录列表
    → 点击标题 → document.getElementById(headingId)?.scrollIntoView()
```

### 全文搜索

```
KbMoreMenu.onOpenSearch() or Ctrl+F
    → KnowledgeBasePage: setShowSearch(true)
    → SearchPanel renders
    → 用户输入 → debounce 300ms
    → api.searchFiles(vaultId, query)
    → GET /api/knowledge/vaults/:id/search?q=...
    → Daemon: fs 遍历 vault, String.includes 匹配
    → 返回 { results: [{ filePath, fileName, snippet }] }
    → 渲染搜索结果，高亮匹配词
    → 点击结果 → onOpenFile(filePath) → kb.selectFile(filePath)
```

### 折叠文件夹

```
KbMoreMenu.onCollapseAll()
    → KnowledgeBasePage: setCollapseAllCounter(prev => prev + 1)
    → KbFileTree: useEffect on counter change → 折叠所有展开目录
```

---

## Files Summary

### Created

| File | Phase |
|------|-------|
| `apps/web/src/components/kb/KbMoreMenu.tsx` | 1 |
| `apps/web/src/components/kb/KbMoreMenu.css` | 1 |
| `apps/web/src/components/kb/OutlinePanel.tsx` | 1 |
| `apps/web/src/components/kb/OutlinePanel.css` | 1 |
| `apps/web/src/components/kb/SearchPanel.tsx` | 2 |
| `apps/web/src/components/kb/SearchPanel.css` | 2 |

### Modified

| File | Phase | Change |
|------|-------|--------|
| **Phase 1** | | |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | 1 | 集成 KbMoreMenu，管理 outline/collapseAll 状态 |
| `apps/web/src/components/kb/KbMainContent.tsx` | 1 | 新增 status bar 渲染 |
| `apps/web/src/components/kb/KbFileTree.tsx` | 1 | collapseAll 支持 |
| `apps/web/src/styles/knowledge.css` | 1 | status bar 样式 |
| **Phase 2** | | |
| `apps/daemon/src/routes/knowledge.ts` | 2 | 新增 `GET /vaults/:id/search` |
| `apps/web/src/api/client.ts` | 2 | 新增 `searchFiles()` |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | 2 | 搜索面板状态 + Ctrl+F 监听 |

---

## Testing Strategy

### E2E Tests (Playwright)

| Test | Scope |
|------|-------|
| `e2e/kb-more-menu.spec.ts` | 菜单展开/关闭，所有菜单项可见，Phase 3 项 disabled |
| `e2e/kb-outline.spec.ts` | 大纲面板打开，标题解析正确，点击跳转 |
| `e2e/kb-status-bar.spec.ts` | 状态栏显示字数/字符/阅读时间，无文件时隐藏 |
| `e2e/kb-search.spec.ts` | 搜索面板打开，输入搜索关键词，结果列表，点击打开文件 |

---

## Backward Compatibility

- **Daemon API**: 新增一个端点，不影响现有路由
- **现有组件**: KbMainContent、KbFileTree、KnowledgeBasePage 的 props 扩展，向后兼容
- **现有 E2E**: 新 data-testid，不修改现有测试
- **Phase 3 预留**: 菜单中的 AI 项 disabled，只是一个占位，不影响功能

## Open Questions

1. **Ctrl+F 拦截范围**：仅 KB 页面拦截还是全局？建议仅 KB 页面，避免影响浏览器默认行为。
2. **搜索性能上限**：vault 超过 1000 个文件时 `fs.readFileSync` 可能成为瓶颈。Phase 2 先加文件数上限（1000），超出提示用户。
3. **大纲滚动高亮**：是否需要 IntersectionObserver 实现自动高亮？Phase 1 先做点击跳转，滚动高亮后续迭代。

## Non-Goals

- 反向链接面板（改为 AI 相关文件推荐，Phase 3）
- Tab 右键菜单（pin/unpin、close others、拖拽排序）
- 标签系统（需要 daemon frontmatter 解析）
- 文件收藏/星标
- Split pane 分屏视图

## Relations

- Parent: [2026-06-23-ui-interaction-optimization-design.md](2026-06-23-ui-interaction-optimization-design.md) — 上一轮交互优化
- Image paste: [2026-06-24-image-paste-design.md](2026-06-24-image-paste-design.md) — 已完成的图片粘贴功能
