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
    graph/                 知识图谱组件
      GraphPage.tsx        图谱主页面（Sigma.js + ForceAtlas2 力导向布局）
      Minimap.tsx          右下角小地图（Canvas 绘制全局节点分布 + 视口指示器）
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
    graph.css   知识图谱样式（画布、顶栏、minimap、加载/错误/空状态）
    knowledge.css 知识库样式（含排版编辑器、样式面板）
  e2e/
    *.spec.ts     Playwright 自动化测试（需先 pnpm dev）
    scenarios/    kimi-webbridge 场景文档（非自动化，手动/AI 驱动）
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

### 知识图谱 (Graph View)

- **渲染引擎**: Sigma.js v3 (WebGL)，通过 `useRef` + `useEffect` 手动绑定，未使用 `@react-sigma/core` 绑定库（更灵活的自定义交互）
- **图数据结构**: Graphology
- **力导向布局**: `graphology-layout-forceatlas2`（ForceAtlas2 算法）
  - `linLogMode: true` — 近距离强排斥，防止节点重叠
  - `barnesHutOptimize: true` — O(n log n) 性能优化
  - 自然社区聚类效果，接近 Obsidian Graph View
- **交互系统**: 原生 DOM 事件（非 Sigma 内置事件），区分 click / drag / dblclick
  - 单击选中节点，双击跳转知识库文档
  - 拖拽节点后通过 `fx`/`fy` 锁定位置
  - Hover 高亮关联节点和边，非关联元素降低透明度
- **Minimap**: Canvas 绘制，右下角显示全局节点分布 + 当前视口矩形
- **React 性能**: 坐标计算和渲染帧循环完全在 Sigma 内部闭环，交互状态用 `useRef`，零 React re-render

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
  "fflate": "^0.8.3",
  "sigma": "^3.x",
  "graphology": "^0.26.x",
  "graphology-layout-forceatlas2": "^0.10.x"
}
```
