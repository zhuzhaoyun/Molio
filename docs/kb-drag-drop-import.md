# KB 拖拽导入 & 内部移动

分支：`feat/kb-drag-and-drop-import` | 日期：2026-07-01 ~ 2026-07-02

## 功能概述

为知识库文件面板新增拖拽导入能力，支持：
- 从 OS 文件管理器拖入文件到任意目录（受保护目录除外）
- 文件树内部拖拽移动文件
- 统一 ImportModal 入口（简化后走同一 API）
- 冲突检测与弹窗处理

---

## 架构

```
OS 文件管理器
    │ drop files
    ▼
KbFilePanel (外部 drop zone)  ←→  KbFileTree (内部 drag-to-move)
    │ POST /api/knowledge/vaults/:id/import         │ PUT /api/knowledge/vaults/:id/files/*
    ▼                                               ▼
Daemon: importFiles() 校验 → 写盘          renamePath() + 保护目录守卫
    │
    ▼
VaultWatcher → SSE → 前端 refreshTree()
```

---

## API

### POST /api/knowledge/vaults/:id/import

- Content-Type: `multipart/form-data`
- Body: `files` (File[]), `targetDir` (string, 可选), `conflict` (string, 默认 `"ask"`)
- 限制: 50MB (Content-Length guard)
- 白名单: `TEXT_EXTS ∪ IMAGE_EXTS ∪ BINARY_EXTS`
- 非法字符: `\ / : * ? " < > |`
- 受保护目录: `wiki/`, `docling_output/`

**冲突策略:** `"ask"` (返回 409 + 冲突列表) | `"skip"` | `"replace"` | `"rename"` (自动加 ` (1)` 后缀)

### PUT /api/knowledge/vaults/:id/files/*

内部移动复用 rename 接口，增加受保护目录校验。

---

## 涉及文件

### 新增
| 文件 | 说明 |
|------|------|
| `apps/web/src/components/kb/ImportConflictDialog.tsx` | 冲突弹窗 |
| `apps/daemon/test/routes/knowledge-import.test.ts` | 14 个单元测试 |
| `apps/web/e2e/drag-drop-import.spec.ts` | 8 个 E2E 测试 |

### 修改
| 文件 | 改动 |
|------|------|
| `apps/daemon/src/core/knowledge.ts` | 导出白名单 + `PROTECTED_DIRS` + `importFiles()` + `renamePath` 守卫 |
| `apps/daemon/src/routes/knowledge.ts` | POST /import 路由 + rename 保护目录校验 |
| `apps/web/src/api/client.ts` | `importFiles()` 方法 |
| `apps/web/src/components/kb/KbFilePanel.tsx` | 外部拖拽 handlers + dragOver/drag-reject 状态管理 |
| `apps/web/src/components/kb/KbFileTree.tsx` | draggable + 内部移动 handlers + drag-target/drag-reject class + 拖拽截图优化 |
| `apps/web/src/components/kb/KbModals.tsx` | ImportModal 简化 |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | import/move/conflict 回调 + pendingImportRef |
| `apps/web/src/styles/knowledge.css` | drag-over/drag-target/drag-reject/conflict-* CSS |
| `apps/web/e2e/area-map.json` | kb-import area |

---

## 迭代优化记录

以下是在初始实现完成后的真机测试中发现并修复的问题。

### 1. 拖拽高亮完全不可见

**现象**：拖文件到目录节点上，节点无任何视觉变化。

**根因**：CSS 用了 `:hover` 伪类 → 浏览器在拖拽期间全局禁用 `:hover`。且 `--accent-tint` 在双主题下几乎等于背景色。

**修复**（5 次迭代）：
1. `:hover` → 显式 `.drag-target` class，在 `handleDirDragOver` 中添加
2. `--accent-tint` → `--accent-soft` + `box-shadow: inset 0 0 0 1.5px var(--accent)` 强调环
3. `border-left` → `box-shadow`（避免内容位移）
4. 内部移动分支补上 class 添加逻辑
5. 添加前清除同面板其他节点 → 同时只有一个高亮；`dragLeave` 检查 `relatedTarget` → 消除闪烁

### 2. 受保护目录无拒绝反馈

**现象**：拖文件到 `wiki/` 或 `docling_output/`，光标变为禁止符但节点无视觉变化。

**修复**：添加 `.drag-reject` → `opacity: 0.35; cursor: not-allowed`，在 `!acceptsDrop` 分支触发，dragLeave/drop/面板清理中移除。

### 3. 拖拽截图杂乱

**现象**：内部拖拽时浏览器截图包含入库状态徽章和"加入 Wiki"按钮。

**修复**：`handleDragStart` 中 clone 节点 → 移除 `.kb-tree-trailing` → `setDragImage()` 设置纯净截图。

### 4. ImportConflictDialog 样式问题

**现象**：全内联样式、选中态不可见、无 hover 态、布局溢出。

**修复**（3 次迭代）：
1. 重构为 CSS class 体系，选中态用 `--accent-soft` + `--accent` 边框，添加 hover 态
2. 压紧间距（padding、gap、字号、文件列表 max-height）
3. **关键修复**：body 添加 `flex: 1; min-height: 0; overflow-y: auto`——`.kb-modal` 是 flex column 布局，body 的 `min-height` 默认为 `auto`（不比内容矮），`overflow-y: auto` 永远不触发；`flex: 1` 将其约束在 header/footer 之间

### 5. ImportModal 冲突重试静默失败

**现象**：通过 ImportModal 导入遇到冲突时弹窗显示但"继续"无反应。

**根因**：`pendingImportRef` 仅由拖拽路径设置，ImportModal 路径未设置。

**修复**：扩展 `onImportComplete` 签名传递 files + targetDir，回调中存入 `pendingImportRef`。

### 6. rawFiles 未清理

**现象**：ImportModal 中移除文件后重新添加同名文件，旧 File 对象残留。

**修复**：`removeFile` 中同步清理 `rawFiles.current`。

---

## 设计原则总结

- **`box-shadow` 优于 `border`**：拖拽反馈不应引起布局位移
- **显式 class 优于 `:hover`**：浏览器在拖拽期间的行为与正常交互不同
- **`min-height: 0` 在 flex 列中是必需的**：否则子元素不会缩小到内容尺寸以下，滚动不生效
- **`setDragImage()` 控制拖拽截图**：浏览器默认截图包含所有子元素，需手动清理
- **受保护目录三层防护**：Daemon 拒绝 + Web 不设 data-drop-dir + 视觉置灰反馈
