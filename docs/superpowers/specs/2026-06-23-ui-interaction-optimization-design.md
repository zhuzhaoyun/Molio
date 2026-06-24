# UI Interaction Optimization — Design Spec

**Date**: 2026-06-23  
**Branch**: `feat/ui-interaction-optimization`  
**Status**: Phase 1, 2 & 3 Complete ✅

## Implementation Progress

| Phase | Feature | Status | Commits |
|-------|---------|--------|---------|
| 1 | File Reference Protocol | ✅ Done | `948e445`..`dc4c376` |
| 2 | KB Inline Q&A Panel | ✅ Done | `445f01a`..`a762efe` |
| 3 | Home Page Input Enhancement | ✅ Done | `d0b60d0`..`9e6e305` |
| — | Image Paste (Phase 3 continued) | ✅ Done | `5a7f349`..`9e6e305` |

### Phase 2 Implementation Notes

- **Daemon fix**: `wikiExtra.filePath` was being sent but daemon only used it for `wikiOperation: 'ingest'`. Added file-content injection with a focused prompt (replacing the broad `WIKI_QUERY_PROMPT` for file-specific Q&A) in `apps/daemon/src/routes/runs.ts`.
- **History categorization**: File Q&A conversations now use `📄 {filename}：{message}` as title to distinguish from general chat.
- **Deferred**: Selected-text "就此提问" float button and resizable panel border — planned as follow-ups.

### Phase 3 Implementation Notes

- **@ File Search**: FilePicker popup triggered by typing `@` in ChatComposer. Built-in search input with auto-focus, filters vault file tree by name/path in real time. Shows relative timestamps (刚刚 / N分钟前 / N小时前 / N天前). Keyboard navigation (Arrow/Enter/Escape). File selected → badge appears in composer, `@` text auto-cleaned.
- **/ Slash Commands**: CommandPalette popup triggered by typing `/`. 5 built-in commands: browse-kb, polish, outline, search, new-chat. Filter by id/label/description. Two interaction modes: **Enter** = execute immediately (navigate / callback); **Tab** = complete template text into textarea for further editing (polish, outline). Commands with `completeText` show "Tab 补全" badge and footer hint. `/new-doc` removed as redundant with browse-kb.
- **Composer Upgrade**: `FileRef` badges rendered above textarea with remove button. `onSend` signature updated to include `fileRefs: FileRef[]` and later `pastedImages: PastedImage[]`. Trigger text auto-removed on selection AND on Escape close. Hint updated to `@ 引用文件  / 命令  粘贴图片  Enter 发送  Shift+Enter 换行`.
- **Landing Page**: Single "📂 浏览知识库" quick action button below the hero section. (Recent files section and "新建文档" button removed as redundant — `@` file search in composer already provides quick file access, and both navigated to the same `/knowledge` route.)
- **FileOperationCard + DiffView**: When AI tools write files, operation cards appear in chat with [打开文件] [查看本次修改] [💬 讨论这个文件] buttons. Inline diff with add/del/ctx lines, supports `[data-theme="dark"]` and `prefers-color-scheme: dark`. Write tools filtered from tool-cards to prevent duplicate rendering.
- **E2E Tests**: 3 spec files (composer-file-picker, composer-slash-commands, landing-page), 14 test cases total.
- **Post-implementation fixes**: DiffView dark theme CSS syntax fix (split `[data-theme]` and `@media` blocks), `computeDiff` empty string guard, unused `shellRef` removed, stale JSDoc cleaned.
- **Deferred**: Drag & drop from KB file tree (cut — `@` search provides same value with better UX).<br/>
  ~~selected-text "就此提问" float button~~ → ✅ Done (`3030ed5`)<br/>
  ~~resizable panel border for FileChatPanel~~ → ✅ Done (`3030ed5`)<br/>
  ~~image paste~~ → ✅ Done (see below)

### Image Paste (Phase 3 continued)

- **Daemon Asset Upload**: `POST /api/knowledge/vaults/:id/assets/upload` — multipart form-data, MIME validation (PNG/JPEG/GIF/WebP), 50MB limit, writes to `{vault}/.molio/assets/YYYY-MM-DD-HHmmss-{seq}.{ext}`, returns `{ filePath, url }`.
- **Thumbnail Badges**: Pasted/selected images show as 56px thumbnail badges above textarea, with loading spinner, error state (red border + retry), and click-to-view-original. Replaces original markdown-text-insertion design.
- **Upload Button**: 🖼 icon-only button (26px) in composer-row left side, triggers hidden `<input type="file" accept="image/*" multiple>`. Tooltip "上传图片".
- **Chat Message Rendering**: `UserMessage` parses `![image](path)` with regex, renders actual `<img>` (max-width 320px) with "查看原图 ↗" link. Raw file URL served via existing `GET /api/knowledge/vaults/:id/raw/*`.
- **onSend Extension**: Signature changed to `(message: string, fileRefs: FileRef[], pastedImages: PastedImage[])`. HomePage converts `pastedImages` to `![image](path)` markdown prefix in message — backend still receives plain text, CLI auto-attaches images.
- **i18n**: 6 composer keys added (zh.ts + en.ts): `uploading`, `uploadError`, `uploadNoVault`, `uploadDismiss`, `uploadImage`, `uploadRetryHint`.
- **E2E Tests**: 3 test cases — paste image shows thumbnail, text paste no upload, upload button exists.
- **Unit Tests**: 5 daemon test cases — vault not found, bad MIME, success (file bytes verified), oversized, no file field.
- **Design spec**: [2026-06-24-image-paste-design.md](2026-06-24-image-paste-design.md)

---

## 1. Problem Statement

Molio 当前各页面之间缺乏联动交互，核心表现为三个具体问题：

1. **首页**：ChatComposer 只有纯文本输入，缺少文件引用、附件添加、快捷跳转等主流交互
2. **知识库**：无法在浏览文件时直接调出问答，文件与 AI 对话的联动缺失
3. **历史记录**：消息中的文件路径无法点击跳转到知识库

这三个问题的根因相同：**缺少一套统一的文件引用 + 跨页面导航机制**，导致每个页面都是信息孤岛。

---

## 2. Design Philosophy: AI-Native over File-Centric

Obsidian 的核心哲学是以文件为中心——wikilink 的终点是打开另一个文件。Molio 的差异化定位是 **AI-Native**：文件引用不只是跳转，更是对话的起点。

| 维度 | Obsidian（基线） | Molio（差异化） |
|------|-----------------|----------------|
| 文件引用点击 | 只打开文件 | 打开 / 询问 / 引用到对话 |
| 聊天中的文件 | 不存在 | 文件引用 + 操作卡片（查看修改、diff） |
| 文件问答 | 不存在 | 知识库页面内就地对话面板 |
| Hover 预览 | 原文前几段 | 未来可扩展 AI 摘要 |

---

## 3. Overall Architecture

```
                          ┌──────────────────┐
                          │   useFileNav()   │  ← 统一文件导航 hook
                          │  上下文感知导航     │
                          └────────┬─────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
     ┌───────▼────────┐  ┌───────▼────────┐  ┌────────▼─────────┐
     │   <FileRef>    │  │ <FilePicker>   │  │ <FileChatPanel>  │
     │  内联文件徽章    │  │ @ 文件搜索弹窗   │  │ 知识库就地问答面板  │
     └───────┬────────┘  └───────┬────────┘  └────────┬─────────┘
             │                   │                    │
    ┌────────┼────────┐         │                    │
    │        │        │         │                    │
┌───▼──┐ ┌──▼──┐ ┌───▼───┐ ┌──▼────────┐  ┌────────▼─────────┐
│Mark- │ │Chat │ │History│ │ChatComposer│  │KnowledgeBasePage │
│down  │ │Msgs │ │Page   │ │  输入框     │  │                   │
│Render│ │     │ │       │ │            │  │                   │
└──────┘ └─────┘ └───────┘ └───────────┘  └──────────────────┘
```

---

## 4. P0 — Knowledge Base Inline Q&A Panel

### 4.1 Current vs Target

**Current flow**: 看文件 → 发现问题 → 切到首页 → 打字 "我刚才看的那个文件..." → 等回复 → 切回知识库  
**Target flow**: 看文件 → 右侧面板直接问 → AI 自动带文件上下文 → 边看文件边聊

### 4.2 Layout

```
┌──────────┬──────────────────┬──────────────┐
│  文件树   │   文件编辑/预览区   │  问答面板      │
│          │                  │  (可收起)      │
│  📁 notes│  # 设计文档        │  ───────────── │
│  📄 设计  │                  │  上下文: 📄设计  │
│  📄 架构  │  讨论了微服务拆     │              │
│          │  分的三种方案...    │  AI: 有什么    │
│          │                  │  想问的？      │
│          │  ┌─ 工具栏 ──────┐│              │
│          │  │ [询问此文件]   ││  用户: 方案B   │
│          │  └──────────────┘│  具体怎么实施？ │
│          │                  │              │
│          │                  │  AI: 根据文件  │
│          │                  │  内容，方案B... │
└──────────┴──────────────────┴──────────────┘
```

### 4.3 Trigger Methods

| 方式 | 操作 | 行为 |
|------|------|------|
| 工具栏按钮 | 点击编辑器顶部 "💬 询问此文件" | 展开面板，当前文件设为上下文 |
| 右键菜单 | 文件树右键文件 → "询问此文件" | 同上 |
| 快捷键 | Ctrl/Cmd + L | 展开面板，聚焦输入框 |
| 选中文本提问 | 预览区选中文本 → 浮动按钮 "就此提问" | 展开面板，选中文本也带入上下文 |

### 4.4 Panel Behavior

- **展开/收起**: 可拖拽左边框调整宽度，复用现有面板 resize 机制
- **上下文标签**: 顶部显示 `上下文: 📄 文件名 ✕`，可移除或替换
- **对话独立**: 不与首页聊天记录混合，是独立的 run
- **Tab 切换**: 切换到不同文件 Tab 时，问答对话重置为新上下文
- **面板持久化**: 同一文件在同一次打开期间的对话保持不丢失，收起后面板内容保留

### 4.5 Technical Implementation

```
KnowledgeBasePage
    │
    ├── KbFilePanel (已有，无需改动)
    ├── KbMainContent (已有)
    │       └── 工具栏新增 "询问此文件" 按钮
    │
    └── FileChatPanel (新增)
            │
            ├── 复用 ChatComposer (已有)
            ├── 复用 AssistantMessage / UserMessage (已有)
            │
            └── useFileChat hook (新增)
                    │
                    ├── 封装 useChatCore
                    │   ├── cwd = 当前 vault 的 localPath
                    │   └── wikiExtra = { filePath }
                    │
                    └── 与 useKnowledge 共享文件上下文
```

**关键设计决策**: 复用 `useChatCore`，只改变 `cwd` 和 `wikiExtra.filePath` 传参。Daemon 侧无需任何改动——`CreateRunRequest.wikiExtra.filePath` 已支持。

### 4.6 New Files

| File | Purpose |
|------|---------|
| `apps/web/src/components/kb/FileChatPanel.tsx` | 问答面板主体组件 |
| `apps/web/src/components/kb/FileChatPanel.css` | 面板样式 |
| `apps/web/src/hooks/useFileChat.ts` | 文件问答 hook，封装 useChatCore |

### 4.7 Modified Files

| File | Change |
|------|--------|
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` | 集成 FileChatPanel，面板展开/收起状态管理 |
| `apps/web/src/components/kb/KbMainContent.tsx` | 工具栏增加 "询问此文件" 按钮 |
| `apps/web/src/components/kb/KbFileTree.tsx` | 右键菜单增加 "询问此文件" 项 |
| `apps/web/src/components/kb/MdRenderer.tsx` | 选中文本浮动按钮 "就此提问" |
| `apps/web/src/styles/knowledge.css` | 三栏布局 + 面板样式 |

---

## 5. P1 — File Reference Protocol + Chat Operation Cards

### 5.1 File Reference Protocol

#### 5.1.1 `<FileRef>` Component

视觉规格——内联徽章，不打断阅读流：

```
普通文本... [📄 设计文档.md] ...继续文本
```

三种状态：

| 状态 | 样式 | 条件 |
|------|------|------|
| 正常 | `📄 文件名` 蓝色可点击 | 文件存在 |
| 失效 | `⚠ 文件名` 灰色 + 删除线 | 文件不存在 |
| 加载 | `🕐 文件名` 骨架样式 | 正在解析路径 |

**交互行为**:

| 操作 | 行为 |
|------|------|
| 单击 | KB 页面 → Tab 内打开；其他页面 → 跳转 `/knowledge` 并打开文件 |
| Ctrl/Cmd + 单击 | 新浏览器标签打开 |
| 右键 | 菜单：打开文件 / 询问此文件 / 复制路径 |

**右键 "询问此文件"**: 跳转到首页，自动创建新对话并附带文件上下文（`wikiExtra.filePath`）。

#### 5.1.2 `useFileNavigation` Hook

```typescript
function useFileNavigation() {
  return {
    // 导航：自动判断当前页面，选择最佳打开方式
    openFile(vaultId: string, filePath: string, opts?: { newTab?: boolean }): void,
    
    // 问文件：跳转到首页并带文件上下文创建新对话
    askAboutFile(vaultId: string, filePath: string): void,
    
    // 引用文件：将文件路径嵌入当前输入框（首页专用）
    citeFile(vaultId: string, filePath: string): void,
  };
}
```

**页面上下文感知**:
- 在 `/knowledge` 页：`openFile` = Tab 内打开（`kb.selectFile`）
- 在其他页：`openFile` = `navigate('/knowledge', { state: { openFile, vaultId } })`

#### 5.1.3 Integration Points

| 位置 | 文件 | 改动 |
|------|------|------|
| Markdown 渲染器 | `MdRenderer.tsx` | 扩展 marked renderer，`[[...]]` → `<FileRef>` |
| 聊天消息 | `AssistantMessage.tsx` | 渲染层扫描文件路径，生成 `<FileRef>` |
| 历史消息 | `HistoryPage.tsx` | 复用 AssistantMessage 的消息渲染，自动获得 FileRef |

#### 5.1.4 File Path Detection Sources

| 方式 | 语法 | 示例 | 适用场景 |
|------|------|------|---------|
| Wikilink | `[[path]]` | `[[notes/设计.md]]` | Markdown 编辑器 / AI 回复 |
| 显式引用 | `@file:path` | `@file:notes/设计.md` | 聊天输入框快捷引用 |
| 自动识别 | 正则匹配 vault 路径模式 | `notes/设计文档.md` | AI 回复 / 历史消息回溯 |

### 5.2 Chat Operation Cards

当 AI 消息包含文件引用且对应 `tool_use` 事件是对该文件的写操作时，在消息末尾插入操作卡片。

#### 5.2.1 Card Specification

```
┌──────────────────────────────────────────────┐
│  📄 notes/设计文档.md                         │
│  ─────────────────────────────────────────── │
│  修改时间: 2分钟前     变更: +12行 -3行         │
│                                              │
│  [打开文件]  [查看本次修改]  [💬 讨论这个文件]   │
└──────────────────────────────────────────────┘
```

**按钮行为**:
- **打开文件**: `useFileNavigation.openFile(vaultId, filePath)`
- **查看本次修改**: 展开内联 diff 视图，对比 tool 输入中的 `new_string` / `old_string`
- **💬 讨论这个文件**: 跳转到知识库并展开该文件的 FileChatPanel

**多文件处理**: 同一消息涉及多个文件时，每文件一个卡片，超过 3 个默认折叠为 "📄 修改了 N 个文件 ▸"。

#### 5.2.2 Diff View

从 `ToolEvent.input` 中提取 `old_string` 和 `new_string`，渲染简化的行内 diff：
- 绿色背景 = 新增行
- 红色背景 = 删除行
- 限制高度 300px，超出可滚动
- 按钮 "在编辑器中打开" 跳转到文件编辑模式

### 5.3 New Files

| File | Purpose |
|------|---------|
| `apps/web/src/components/FileRef.tsx` | 文件引用内联组件 |
| `apps/web/src/components/FileRef.css` | 徽章 + 状态样式 |
| `apps/web/src/components/FileOperationCard.tsx` | 聊天操作卡片组件 |
| `apps/web/src/components/FileOperationCard.css` | 卡片样式 |
| `apps/web/src/components/DiffView.tsx` | 内联 diff 视图 |
| `apps/web/src/components/DiffView.css` | diff 样式 |
| `apps/web/src/hooks/useFileNavigation.ts` | 文件导航 hook |

### 5.4 Modified Files

| File | Change |
|------|--------|
| `apps/web/src/components/AssistantMessage.tsx` | 识别文件路径 → `<FileRef>`；检测写操作 → `<FileOperationCard>` |
| `apps/web/src/components/kb/MdRenderer.tsx` | marked 扩展：wikilink → `<FileRef>` |
| `apps/web/src/components/history/HistoryPage.tsx` | 历史消息接入 FileRef（通过 AssistantMessage 复用获得） |
| `apps/web/src/styles/chat.css` | FileRef 和卡片样式 |

---

## 6. P2 — Home Page Input Enhancement

### 6.1 @ File Search

输入 `@` 触发文件搜索弹窗，选中后以引用徽章嵌入输入框。

**弹窗规格**:

```
┌─────────────────────┐
│ 🔍 设...             │  ← 搜索框，实时过滤
│─────────────────────│
│ 📄 设计文档.md       │  ← 当前 vault 文件
│ 📄 设计评审.md       │
│ 📄 设计方案对比.md    │
│ 📁 设计稿/           │  ← 文件夹（灰显，不可引用）
└─────────────────────┘
```

**细节**:
- 搜索范围为当前活跃 vault，用户可通过切换 vault 改变搜索范围
- 无搜索词时显示最近 5 个文件（按 `updatedAt` 排序）
- 输入过滤词后实时搜索（复用文件树 API）
- 选中后以 `[📄 文件名 ✕]` 徽章嵌入输入框
- 多个引用块可同时存在
- 引用块不计入消息字数，提交时转为结构化数据

### 6.2 Slash Commands `/`

输入 `/` 触发命令面板。

**命令列表**:

| 命令 | 图标 | 描述 | 行为 |
|------|------|------|------|
| `/new-doc` | 📝 | 新建文档 | 弹出文件名输入，在 vault 创建新 .md |
| `/browse-kb` | 📂 | 浏览知识库 | `navigate('/knowledge')` |
| `/polish` | 🧹 | 优化文字 | 将当前打开 KB 文件的最新内容发送给 AI 润色（需在 KB 页面打开过文件） |
| `/outline` | 📊 | 生成大纲 | 对当前文件生成结构大纲 |
| `/search` | 🔍 | 搜索全部文档 | 打开全局搜索弹窗 |
| `/new-chat` | 💬 | 新建对话 | 重置当前聊天 |

**实现**:
- 命令定义在 `apps/web/src/commands/` 目录下的注册表中
- 每个命令: `{ id, icon, label, description, action }`
- `action` 可以是前端导航操作或构造特定 AI prompt
- 支持继续输入过滤：`/new` 只显示匹配命令
- 未来可扩展自定义命令

### 6.3 Drag & Drop + Image Paste

**拖拽文件**: 文件从知识库拖到输入区 → drop zone 高亮 → 释放后以引用徽章嵌入输入框。

**图片粘贴**: Ctrl/Cmd+V 粘贴图片 → 上传到 `{vault}/assets/` → 以 `![[assets/xxx.png]]` 嵌入消息。

### 6.4 Landing Page — Recent Files

着陆页（无消息时）重新设计，增加文件快速入口：

```
┌──────────────────────────────────┐
│  最近文件                         │
│  📄 设计文档.md          2小时前   │
│  📄 API 设计.md           昨天     │
│  📄 技术选型.md           昨天     │
│                                  │
│  快速操作                         │
│  📝 新建文档    📂 浏览知识库      │
│                                  │
│  ─────────────────────────────── │
│  输入你的问题...                   │
└──────────────────────────────────┘
```

**最近文件**: 从当前 vault 取 `updatedAt` 前 5 个，点击 → 跳转到知识库打开。
**品牌标记**: "墨 Molio" 移到 NavRail 顶部或改为更低调的展示，不占据核心区域。

### 6.5 Composer Internal State

`ChatComposer` 新增内部状态：

```typescript
interface ComposerState {
  text: string;                              // 纯文本部分
  fileRefs: Array<{ vaultId: string; filePath: string }>;  // 引用的文件
  images: Array<{ localPath: string; assetPath: string }>; // 粘贴的图片
}
```

提交时：
- `text` → `CreateRunRequest.message`
- `fileRefs` → 拼入 `message` 前缀或扩展 `wikiExtra`
- `images` → 上传到 assets 后以 wikilink 形式嵌入

### 6.6 New Files

| File | Purpose |
|------|---------|
| `apps/web/src/components/FilePicker.tsx` | @ 文件搜索弹窗 |
| `apps/web/src/components/FilePicker.css` | 弹窗样式 |
| `apps/web/src/components/CommandPalette.tsx` | / 命令面板 |
| `apps/web/src/components/CommandPalette.css` | 面板样式 |
| `apps/web/src/components/LandingPage.tsx` | 着陆页（从 HomePage 拆分） |
| `apps/web/src/components/LandingPage.css` | 着陆页样式 |
| `apps/web/src/commands/index.ts` | 命令注册表 |
| `apps/web/src/commands/builtin.ts` | 内置命令定义 |

### 6.7 Modified Files

| File | Change |
|------|--------|
| `apps/web/src/components/HomePage.tsx` | 着陆态重构 + 集成 FilePicker/CommandPalette |
| `apps/web/src/components/ChatComposer.tsx` | @ 和 / 触发检测、fileRefs 状态、拖拽 drop zone、图片粘贴 |
| `apps/web/src/api/client.ts` | 图片上传 API（如不存在） |
| `apps/web/src/styles/home.css` | 着陆页 + 输入增强样式 |

---

## 7. Implementation Sequence

```
Phase 1 (基础设施)
  ├── useFileNavigation hook
  ├── <FileRef> 组件
  ├── MdRenderer wikilink 扩展
  └── AssistantMessage 接入 FileRef
        → 解决问题 3: 历史记录文件可点击跳转

Phase 2 (知识库就地问答)
  ├── FileChatPanel 组件
  ├── useFileChat hook
  ├── KnowledgeBasePage 集成
  └── KbMainContent 工具栏 + 右键菜单
        → 解决问题 2: 知识库文件联动问答

Phase 3 (首页增强)
  ├── <FilePicker> + @ 搜索
  ├── <CommandPalette> + / 命令
  ├── ChatComposer 改造 (引用徽章、拖拽、粘贴)
  ├── <FileOperationCard> + DiffView
  └── LandingPage 重构 (最近文件)
        → 解决问题 1: 首页交互增强
```

**依赖关系**: Phase 2 依赖 Phase 1 的 `<FileRef>` 和 `useFileNavigation`。Phase 3 依赖 Phase 1 和 2。

**推荐**: 三个 Phase 各自一个 PR，按顺序合并。

---

## 8. Component Dependency Graph

```
Phase 1:                          Phase 2:                    Phase 3:
─────────────────────────────────────────────────────────────────────────
useFileNavigation ──────────┬──▶ useFileChat               FilePicker
                            │         │                    CommandPalette
<FileRef> ◀─────────────────┘    FileChatPanel ──▶ ChatComposer (改造)
    │                                │                    │
    ├── MdRenderer (wikilink)        │              LandingPage
    └── AssistantMessage             │              FileOperationCard
         │                           │                    │
         └── HistoryPage             │              DiffView
         └── HomePage (chat msgs)    │
                                     │
                              KnowledgeBasePage
```

---

## 9. Data Flow

### 9.1 File Navigation Flow

```
User clicks <FileRef>
    │
    ▼
useFileNavigation.openFile(vaultId, filePath)
    │
    ├── Current page = /knowledge ?
    │   YES → kbTabsStore.openTab(filePath)       // 在 KB 内打开
    │   NO  → navigate('/knowledge', { state })   // 跳转
    │            └── KnowledgeBasePage useEffect
    │                  └── kb.selectFile(state.openFile)
    │
    └── File exists? → API check → update <FileRef> state
```

### 9.2 File Chat Flow

```
User triggers "询问此文件"
    │
    ▼
KnowledgeBasePage sets { chatPanelOpen: true, chatFilePath }
    │
    ▼
FileChatPanel mounts
    │
    ▼
useFileChat(vaultId, filePath)
    │
    ▼
User types question → ChatComposer.onSend(text)
    │
    ▼
api.createRun({
  agentId, message: text,
  cwd: vault.localPath,
  wikiExtra: { filePath }
})
    │
    ▼
subscribeToRun(runId)
    │
    ▼
SSE events → updateWithEvent → render
```

### 9.3 @ File Search Flow

```
User types "@" in ChatComposer
    │
    ▼
<FilePicker> opens below input
    │
    ▼
User types filter → api.listFiles(vaultId, filter)
    │
    ▼
User selects file
    │
    ▼
ChatComposer adds fileRef to state
    │
    ▼
<FileRef> badge rendered inside textarea area
```

---

## 10. Backward Compatibility

- **Daemon API**: 零改动。`wikiExtra.filePath` 已存在，问答面板只是换了一个 UI 入口触发相同的 API
- **现有路由**: 不新增路由。FileChatPanel 是 KnowledgeBasePage 内组件，不改变 URL 结构
- **现有状态管理**: `useKnowledge` 和 `vaultStore` 保持不变。新增的 hook 和 store 独立存在
- **E2E 测试**: 现有测试不受影响。新功能增加新的 `data-testid` 属性

---

## 11. Testing Strategy

### 11.1 E2E Tests (Playwright)

| Test | Scope | Key Assertions |
|------|-------|---------------|
| `e2e/file-ref-navigation.spec.ts` | Phase 1 | wikilink 点击跳转；失效文件样式；右键菜单 |
| `e2e/operation-cards.spec.ts` | Phase 1 | AI 修改文件后出现操作卡片；diff 展开/收起 |
| `e2e/file-chat-panel.spec.ts` | Phase 2 | 面板展开/收起；文件上下文传递；选中文本提问 |
| `e2e/composer-file-picker.spec.ts` | Phase 3 | @ 触发搜索；选中嵌入徽章；移除徽章 |
| `e2e/composer-slash-commands.spec.ts` | Phase 3 | / 触发面板；命令过滤；命令执行 |
| `e2e/landing-page.spec.ts` | Phase 3 | 最近文件展示；快速操作按钮；着陆 → 聊天转换 |

### 11.2 Unit Tests (node:test)

| Test | Scope |
|------|-------|
| `test/file-nav/useFileNavigation.test.ts` | 页面上下文感知逻辑 |
| `test/chat/composer-state.test.ts` | Composer 状态管理 |
| `test/kb/file-chat.test.ts` | useFileChat hook 集成测试 |

---

## 12. Open Questions

1. **图片上传端点**: daemon 侧是否有 `POST /api/vaults/:id/assets`？如无，需要在 Phase 3 之前新增
2. **最近文件数据源**: 用 `api.listFiles` 排序还是新增 `/api/vaults/:id/recent` 端点？先用现有 API 排序，如有性能问题再优化
3. **选中文本上下文传递**: `wikiExtra` 是否需要新增 `selectedText` 字段？建议新增，daemon 侧把选中文本作为额外上下文拼接

---

## 13. Non-Goals (Explicitly Out of Scope)

- ~~Hover AI 摘要~~ — 需要 wiki build 时预生成摘要，链路长，后续迭代
- ~~对话溯源（哪些对话引用了该文件）~~ — 需要 daemon 侧记录 run-file 关联，后续迭代
- ~~Obsidian 的 backlinks 面板~~ — 超出本次交互优化范围
- ~~命令面板的自定义命令功能~~ — Phase 3 先做内置命令，扩展性留接口
- ~~移动端适配~~ — 本次仅桌面端
- ~~系统文件拖拽~~ — Phase 3 只做知识库内文件拖拽，系统文件拖拽后续

---

## 14. Visual Style Notes

- **<FileRef> 徽章**: 圆角 4px，背景 `var(--color-surface-2)`，hover 背景 `var(--color-accent-light)`，字号 0.9em
- **操作卡片**: 圆角 8px，背景 `var(--color-surface-1)`，边框 `1px solid var(--color-border)`，内边距 12px
- **FileChatPanel**: 默认宽度 360px，最小 280px，最大 50vw，可拖拽调整
- **@ 弹窗 / 命令面板**: 圆角 8px，阴影 `0 4px 16px rgba(0,0,0,0.12)`，最大高度 320px，滚动
- **diff 视图**: 等宽字体，+行 `#dafbe1` 背景，-行 `#ffebe9` 背景，无行号
