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
  index.ts             入口：@hono/node-server，监听 :3100
  server.ts            Hono app 定义、路由挂载、CORS、优雅关闭、静态文件服务
  sse.ts               SSE transport helper
  types.ts             内部类型 (RunState, BufferedEvent)
  core/
    RunManager.ts      Run 生命周期管理 (create/cancel/submitToolResult)
    config.ts          配置文件加载 (~/.molio/config.json)
    db.ts              SQLite 数据库初始化
    transcript.ts      多轮对话 transcript 构建
    knowledge.ts       知识库管理（vault、文件树）
    wiki-prompts.ts    Wiki 系统提示词模板（QUERY/WEIXIN always-on 角色帧，物化成 sysprompt 文件）
    tools/skills/      Builtin Claude Code skills（wechat-article-extractor, docx/pdf/pptx/xlsx, wiki-build/ingest/lint/save）—— wiki 操作走 skills，agent 按动词 on-demand 调用，不再有 wikiOperation prepend
    runtimes/
      registry.ts      Agent 定义注册表 (claude, codex, gemini, qwen)
      claude.ts        Claude Code runtime 定义
      codex.ts         OpenAI Codex runtime 定义
      gemini.ts        Gemini CLI runtime 定义
      qwen.ts          Qwen Code runtime 定义
      launch.ts        二进制路径解析 + 版本探测
      env.ts           spawn 环境变量构建
    streams/
      claude-stream.ts     Claude JSONL 流解析
      codex-stream.ts      Codex 流解析
      json-event-stream.ts 通用 JSON 事件流处理
      jsonl-parser.ts      JSONL 解析器
    conversations/
      service.ts       统一会话服务（跨渠道 conversation 管理）
      run-starter.ts   共享"在已有会话上建 run"逻辑（runs + rewind-resend 复用：vault 系统提示 + append user + createRun + onTurnComplete）
    weixin/
      client.ts        微信消息收发
      message.ts       消息解析
      service.ts       微信服务编排
      types.ts         微信类型定义
  routes/
    agents.ts         GET /api/agents — 列出可用 agent
    runs.ts           POST /api/runs — 创建 run, GET 列出/查询
    events.ts         GET /api/runs/:id/events — SSE 事件流
    tool-result.ts    POST /api/runs/:id/tool-result — 提交工具结果
    config.ts         GET/PUT /api/config — 读写配置
    conversations.ts  CRUD /api/conversations — 会话管理
    projects.ts       CRUD /api/projects — 项目管理
    knowledge.ts      CRUD /api/knowledge — 知识库管理
    publish.ts        POST /api/publish — 发布到内容平台
    graph.ts          GET /api/graph — 知识图谱数据
    weixin.ts         POST /api/weixin — 微信回调
  publish-bridge/
    bridge-page.ts    发布桥接页面逻辑
test/                  测试用例 (node:test)，按源码模块子目录组织
  core/               config, db, transcript, run-event-buffer, knowledge, conversations, weixin
  streams/            claude-stream, codex-stream, json-event-stream, jsonl-parser
  runtimes/           env, launch-detection, claude-permission-mode, windows-cmd-resolution
  routes/             agent-test-multiturn, knowledge, publish, sse
  compat/             esm-compat, port-check
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
| GET/POST/PUT/DELETE | `/api/projects` | 项目 CRUD |
| GET | `/api/conversations` | 列出全局会话历史 |
| GET | `/api/conversations/:id` | 查询单个会话 |
| GET | `/api/conversations/:id/messages` | 列出会话全部消息 |
| DELETE | `/api/conversations/:id` | 删除会话 |
| POST | `/api/conversations/:id/rewind-resend` | 重新生成/编辑重发（回退到末条 user 消息重放建新 run） |
| POST | `/api/conversations/:id/delete-messages` | 按 id 集合删除消息（勾选删除） |
| GET/POST/PUT/DELETE | `/api/knowledge` | 知识库管理 |
| POST | `/api/publish` | 发布到内容平台 |
| GET | `/api/graph` | 知识图谱数据 |
| POST | `/api/weixin` | 微信回调 |

## 关键设计

- **RunManager** 是核心单例，管理所有活跃 run 的生命周期
- 每个 run 通过 `child_process.spawn` 启动本地 AI CLI 进程
- stdout 输出经 stream handler 解析为 `AgentEvent`，通过 SSE 推送给前端
- 事件缓冲区限制 2000 条，run TTL 30 分钟
- 支持多轮对话 (transcript 构建)
- SQLite 存储项目、会话、知识库等持久化数据

## 统一会话 / 渠道设计

- **Channel 只做外部通道适配**：微信、飞书、企业微信等模块只负责登录、轮询/回调、消息解析、发送回复和通道私有 token；不要在通道模块里实现长期会话历史。
- **Conversation 是统一会话边界**：所有桌面端、微信、未来飞书/企业微信发起的对话都写入公共 conversations/messages 存储，后续"历史记录"页面从这里统一查询。
- **Run 是一次执行，不是会话**：每条外部消息可以创建一个新的 run，但必须携带稳定 conversationId 和历史 messages，让模型能理解上下文。**例外：stream-json 多轮 agent（如 Claude Code）**——微信通道按 `fromUserId` 复用同一 multi-turn run，后续消息走 `RunManager.sendMessage()` 写入已有进程的 stdin，而非每条消息新开进程。`WeixinService` 用 `userRuns` 维护每用户的活跃 run，turn 进行中时排队、`turn_end` 后 drain；进程失活（`canAcceptMessage=false`）或 `/new` 时回退到新开 run。这保留了 agent 原生 session 连续性与 prompt cache。
- **外部身份映射规则**：外部通道用 `channel_type + external_session_id` 定位同一个 conversation，例如 `weixin + fromUserId`、`feishu + openId`、`wecom + userId`。
- **渠道模块保持干净独立**：`core/weixin` 不直接关心数据库表结构、不维护自有 session store；它通过公共 `ConversationService` 获取/创建会话、读取历史、追加用户和助手消息。
- **系统渠道项目**：当前数据库仍要求 `conversations.project_id NOT NULL`，外部渠道会话挂到隐藏系统项目 `__molio_channels__` 下；项目列表接口应过滤系统项目，避免污染用户项目。

## 测试规范

遵循项目根目录 CLAUDE.md 中的**错误驱动测试**规则：每个 bug 在 `test/` 下按源码模块子目录添加复现测试用例。

**目录映射**：测试子目录与 `src/` 源码模块一一对应：
- `test/core/` → `src/core/`（config, db, transcript, RunManager, knowledge, conversations, weixin, wiki-prompts）
- `test/streams/` → `src/core/streams/`（流解析器）
- `test/runtimes/` → `src/core/runtimes/`（agent 运行时、launch、env）
- `test/routes/` → `src/routes/` + `src/sse.ts`（API 路由、SSE）
- `test/compat/` → 跨模块兼容性检查（ESM、端口检测）