# @kge/web — Web UI

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
  components/
    HomePage.tsx    主页：agent 选择 + 聊天面板
    NavRail.tsx     左侧导航栏
    ChatPane.tsx    聊天消息列表
    ChatComposer.tsx 消息输入框
    UserMessage.tsx 用户消息气泡
    AssistantMessage.tsx 助手消息气泡 (thinking + tool cards)
    ThinkingBlock.tsx    思考过程折叠块
    ToolCard.tsx         工具调用卡片
  styles/
    tokens.css    CSS 变量 (颜色、间距、字体)
    base.css      基础重置样式
    rail.css      导航栏样式
    home.css      主页样式
    chat.css      聊天组件样式
e2e/
    *.e2e.md      E2E 测试场景描述
```

## 命令

```bash
pnpm dev          # vite dev server (:5173)
pnpm build        # vite build
pnpm preview      # vite preview
pnpm typecheck    # tsc --noEmit
```

## 关键设计

- **Shell 布局**: NavRail (左侧导航) + 主内容区
- **视图**: home (聊天) / knowledge (知识库，待实现) / runtimes (运行时管理，待实现)
- **聊天流程**: 选择 agent → 输入消息 → POST /api/runs → 订阅 SSE → 实时渲染事件
- **消息模型**: user / assistant / error，assistant 消息包含 thinking、tools、usage
- **SSE**: 通过 `EventSource` 订阅 daemon 事件流，实时更新消息状态

## 与 daemon 的交互

- HTTP 请求发往 `http://localhost:3100/api/*`
- SSE 事件流: `GET /api/runs/:id/events`
- CORS 已配置允许 `localhost:5173`
