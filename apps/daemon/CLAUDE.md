# @molio/daemon — Backend Server

Hono HTTP server，负责本地 AI runtime 编排、run 生命周期管理、SSE 事件推送。

## 技术栈

- **Runtime**: Node.js + TypeScript (ESM)
- **HTTP Framework**: Hono + `@hono/node-server`
- **Database**: better-sqlite3 (SQLite)
- **Dev**: tsx watch (热重载)
- **Test**: node:test (内置测试框架)

## 目录结构

```
src/
  index.ts          入口：@hono/node-server，监听 :3100
  server.ts         Hono app 定义、路由挂载、CORS、优雅关闭
  sse.ts            SSE transport helper
  types.ts          内部类型 (RunState, BufferedEvent)
  core/
    RunManager.ts   Run 生命周期管理 (create/cancel/submitToolResult)
    config.ts       配置文件加载 (~/.molio/config.json)
    db.ts           SQLite 数据库初始化
    transcript.ts   多轮对话 transcript 构建
    runtimes/
      registry.ts   Agent 定义注册表 (claude, codex, gemini, qwen)
      claude.ts     Claude Code runtime 定义
      codex.ts      OpenAI Codex runtime 定义
      gemini.ts     Gemini CLI runtime 定义
      qwen.ts       Qwen Code runtime 定义
      launch.ts     二进制路径解析 + 版本探测
      env.ts        spawn 环境变量构建
    streams/
      claude-stream.ts    Claude JSONL 流解析
      codex-stream.ts     Codex 流解析
      json-event-stream.ts  通用 JSON 事件流处理
      jsonl-parser.ts     JSONL 解析器
  routes/
    agents.ts       GET /api/agents — 列出可用 agent
    runs.ts         POST /api/runs — 创建 run, GET 列出/查询
    events.ts       GET /api/runs/:id/events — SSE 事件流
    tool-result.ts  POST /api/runs/:id/tool-result — 提交工具结果
    config.ts       GET/PUT /api/config — 读写配置
    projects.ts     CRUD /api/projects — 项目管理 (SQLite)
test/               测试用例 (node:test)，按源码模块子目录组织
  core/             config, db, transcript, run-event-buffer
  streams/          claude-stream, codex-stream, json-event-stream, jsonl-parser
  runtimes/         env, launch-detection, claude-permission-mode, windows-cmd-resolution
  routes/           publish, sse
  compat/           esm-compat, port-check
```

## 命令

```bash
pnpm dev          # tsx src/index.ts
pnpm dev:watch    # tsx watch src/index.ts (热重载，独立开发用)
pnpm build        # tsc 编译到 dist/
pnpm test         # tsc && node --test "dist/test/**/*.test.js"
pnpm typecheck    # tsc --noEmit
```

## API 端点

| Method | Path | 描述 |
|--------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/agents` | 列出可用 runtime agent |
| POST | `/api/runs` | 创建新 run |
| GET | `/api/runs` | 列出所有 run |
| GET | `/api/runs/:id` | 查询单个 run |
| GET | `/api/runs/:id/events` | SSE 事件流 |
| POST | `/api/runs/:id/tool-result` | 提交 tool result |
| GET | `/api/config` | 读取配置 |
| PUT | `/api/config` | 更新配置 |
| GET/POST/PUT/DELETE | `/api/projects/*` | 项目 CRUD |

## 关键设计

- **RunManager** 是核心单例，管理所有活跃 run 的生命周期
- 每个 run 通过 `child_process.spawn` 启动本地 AI CLI 进程
- stdout 输出经 stream handler 解析为 `AgentEvent`，通过 SSE 推送给前端
- 事件缓冲区限制 2000 条，run TTL 30 分钟
- 支持多轮对话 (transcript 构建)
- SQLite 存储项目和对话持久化数据

## 测试规范

遵循项目根目录 CLAUDE.md 中的**错误驱动测试**规则：每个 bug 在 `test/` 下按源码模块子目录添加复现测试用例。

**目录映射**：测试子目录与 `src/` 源码模块一一对应：
- `test/core/` → `src/core/`（config, db, transcript, RunManager）
- `test/streams/` → `src/core/streams/`（流解析器）
- `test/runtimes/` → `src/core/runtimes/`（agent 运行时、launch、env）
- `test/routes/` → `src/routes/` + `src/sse.ts`（API 路由、SSE）
- `test/compat/` → 跨模块兼容性检查（ESM、端口检测）
