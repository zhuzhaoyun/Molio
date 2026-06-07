# @molio/web — Web UI

Vite + React 前端，消费 daemon SSE 事件流，提供聊天式 AI 交互界面。

## 技术栈

- **Framework**: React 19 + TypeScript
- **Build**: Vite 6
- **样式**: 纯 CSS (CSS Variables + 组件级 CSS 文件)
- **状态管理**: React hooks (useState/useRef/useCallback)

## 目录结构

```
src/
  main.tsx          React 入口
  App.tsx           根组件：视图路由 (home / knowledge / runtimes)
  App.css           全局布局样式
  api/
    client.ts       HTTP 客户端 (fetch wrapper)
    sse.ts          SSE 订阅 (EventSource)
  hooks/
    useAgents.ts    获取可用 agent 列表
    useChat.ts      聊天状态管理 (消息、发送、SSE 订阅)
    useProjects.ts  项目管理
    useKnowledge.ts 知识库状态管理（vault、文件树、排版模式）
  components/
    HomePage.tsx    主页：agent 选择 + 聊天面板
    NavRail.tsx     左侧导航栏
    ChatPane.tsx    聊天消息列表
    ChatComposer.tsx 消息输入框
    UserMessage.tsx 用户消息气泡
    AssistantMessage.tsx 助手消息气泡 (thinking + tool cards)
    ThinkingBlock.tsx    思考过程折叠块
    ToolCard.tsx         工具调用卡片
    kb/                    知识库组件
      KnowledgeBasePage.tsx  知识库页面（文件面板 + 主内容区）
      KbFilePanel.tsx         文件树面板（搜索、文件列表、vault 切换）
      KbMainContent.tsx       主内容区（渲染 + 排版模式）
      KbModals.tsx            模态框（vault 创建/切换/导入/COSE 安装提示）
      MdRenderer.tsx          doocs/md 渲染引擎封装
      MdTypesetEditor.tsx     左右分栏排版编辑器
      MdStylePanel.tsx        样式面板（主题/字体/颜色/选项）
  styles/
    tokens.css    CSS 变量 (颜色、间距、字体)
    base.css      基础重置样式
    rail.css      导航栏样式
    home.css      主页样式
    chat.css      聊天组件样式
    knowledge.css 知识库样式（含排版编辑器、样式面板）
  vendor/
    doocs-md/     从 doocs/md vendored 的核心渲染代码
      src/
        renderer/     marked 渲染器 + 自定义扩展
        extensions/   扩展（KaTeX、Mermaid、alert、代码高亮等）
        theme/        主题系统 + CSS 处理
        utils/        工具函数
      themes/       主题 CSS（base、default、grace、simple）
      shared/       共享类型和工具
      package.json  本地包配置
      scripts/
        update-doocs-md.sh  更新脚本
```

## 命令

```bash
pnpm dev          # vite dev server (:5173)
pnpm build        # vite build
pnpm preview      # vite preview
pnpm typecheck    # tsc --noEmit
pnpm test:e2e     # Playwright E2E 测试（需先运行 pnpm dev）
```

## 关键设计

### 知识库 (Knowledge Base)

- **文件面板**: 左侧文件树，支持搜索、vault 切换
- **主内容区**: 
  - **默认模式**: 直接显示 doocs/md 渲染内容（无 tabs）
  - **排版模式**: 左右分栏编辑器（左侧 Markdown 源码，右侧实时预览）
- **右上角按钮**:
  - 默认模式：「排版」按钮
  - 排版模式：「退出排版」「复制」「发布」「样式」按钮
- **样式面板**: 右侧悬浮面板，支持主题、字体、字号、主题色、排版选项切换
- **渲染引擎**: 基于 doocs/md (`marked` v18 + 扩展 + 主题系统)

### 聊天 (Chat)

- **Shell 布局**: NavRail (左侧导航) + 主内容区
- **视图**: home (聊天) / knowledge (知识库) / runtimes (运行时管理)
- **聊天流程**: 选择 agent → 输入消息 → POST /api/runs → 订阅 SSE → 实时渲染事件
- **消息模型**: user / assistant / error，assistant 消息包含 thinking、tools、usage
- **SSE**: 通过 `EventSource` 订阅 daemon 事件流，实时更新消息状态

## 与 daemon 的交互

- HTTP 请求发往 `http://localhost:3100/api/*`
- SSE 事件流: `GET /api/runs/:id/events`
- CORS 已配置允许 `localhost:5173`

## doocs/md 集成

### Vendor 方式

`@md/core` 未发布到 npm，已将核心代码 vendor 到 `vendor/doocs-md/`，配合更新脚本：

```bash
# 从上游更新（默认 main 分支）
./scripts/update-doocs-md.sh

# 指定版本
./scripts/update-doocs-md.sh v2.1.0
```

### 组件架构

- **MdRenderer**: 封装 doocs/md 渲染引擎，提供 React 组件接口
- **MdTypesetEditor**: 左右分栏编辑器，左侧 Markdown 源码，右侧实时预览
- **MdStylePanel**: 样式配置面板，支持主题、字体、字号、颜色、选项切换

### 依赖

```json
{
  "marked": "^18.0.4",
  "highlight.js": "^11.11.1",
  "front-matter": "^4.0.2",
  "isomorphic-dompurify": "^3.15.0",
  "es-toolkit": "^1.47.0",
  "fflate": "^0.8.3"
}
```
