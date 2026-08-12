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
    tools/skills/      Builtin Claude Code skills（wechat-article-extractor, docling, wiki-build/ingest/lint/save/query）—— wiki 操作走 skills，agent 按动词 on-demand 调用；知识库问答走 wiki-query skill（由 vault .claude/CLAUDE.md 常驻规则 + KB 面板确定性触发），不再有 system-prompt 注入。wiki-* 五件套（build/query/ingest/save/lint）同版本号共进：改任一 skill 时五个 version: 一起 bump 到同一版本（同步本身按内容哈希镜像到既有 vault，version 只作诊断/约定）。remotion 已退役（见 skill-installer.ts 的 RETIRED_BUNDLED_SKILLS）：视频创作改由技能商店 am-will/remotion 按需安装；本目录下的 remotion/ 源文件刻意保留，作为清理旧 vault 副本时的字节级权属证明
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
    channels/         跨渠道共享抽象（weixin/feishu/wecom 都走这条 dispatcher）
      types.ts          ChannelSink 接口、ConnectionState 多态
      dispatcher.ts     ChannelDispatcher — 把外部消息→conversation→run 的样板抽出来
      credentials-store.ts  跨渠道凭证文件读写（~/.molio/<channel>-credentials.json，原子写 + chmod 0o600）
      message-dedup.ts     MessageDedup 类 — 按消息 id 去重，TTL + 可选 maxEntries 淘汰
      text-chunker.ts      chunkText(text, limit) — 按 \n\n / \n / 硬切 三级切分
      outbound-media.ts 渠道回复中"图片/文件"出站协议
      media-helpers.ts  共享 media 下载/缓存工具
    weixin/
      client.ts        微信消息收发
      message.ts       消息解析 + buildWeixinFrameMessage（首轮前置 channel frame）
      channel-frame.ts 微信通道角色帧（收件/URL提取/<attach/>回传/意图分流，问答路由到 wiki-query skill）
      dispatcher.ts    微信多轮 run 复用/排队状态机
      service.ts       微信服务编排（implements ChannelSink）
      types.ts         微信类型定义
    feishu/
      client.ts        Lark REST API 包装 (tenant_access_token、im/v1 消息收发：text/interactive card/image/file 共享 postMessage)
      card.ts          buildMarkdownCard — JSON 2.0 interactive 卡片（markdown 元素），回复包成卡片渲染 Markdown，发送失败降级纯文本
      ws-client.ts     WebSocket 长连接 — 接收 im.message.receive_v1 事件
      message.ts       事件 payload 解析 + buildFeishuFrameMessage（首轮前置 channel frame）
      channel-frame.ts 飞书通道角色帧（收件/URL提取/<attach/>回传/意图分流，问答路由到 wiki-query skill）
      media.ts         图片/文件下载到 raw/feishu/<date>/
      token-store.ts   FeishuTokenStore — tenant_access_token 内存缓存 + 磁盘持久化 + 100min 刷新定时器
      service.ts       状态机 (idle/connecting/connected/reconnecting/error)，token 生命周期委托 token-store
      types.ts         FeishuStatus / FeishuConfig / FeishuRawEvent
    auth/             云端认证 client（用户模块 M2/M4；Web UI 永不直连云端，一切经 daemon）
      token-store.ts   ~/.molio/auth-tokens.json 异步读写（复用 credentials-store 原子写 + chmod 0o600）；两种落盘格式按字段判别：明文 AuthTokens JSON（基线，D3）/ 信封 {v:1, encrypted:<base64>}（桌面模式 safeStorage 加密）；读失败（损坏/解密失败/未配置 crypto 遇信封）一律 null **不删文件**；写降级按模式判定：配置 crypto 但加密失败 → 跳过落盘保内存（绝不静默明文），未配置 → 明文；crypto provider 模块级可注入（setTokenCryptoProvider，测试用）；解码 access JWT exp；token 不进 config.json
      desktop-crypto.ts 桌面端加密 RPC 客户端 — daemon 以 ELECTRON_RUN_AS_NODE 运行无 Electron API，fetch 主进程 crypto-server（端口 env MOLIO_DESKTOP_CRYPTO_PORT，先例 = wiki-fetcher 的 MOLIO_DESKTOP_FETCH_PORT）；2s 超时、**从不抛错**（任何失败返回 null，token-store 据此降级）；env 缺失 = 未配置（dev/Docker/独立 daemon → 明文基线）
      auth-client.ts   AuthClient — 唯一云端通信方（MOLIO_AUTH_URL env，未配置时端点回 503）：sendCode/verify/logout/deleteAccount（注销云端优先：云端失败抛错不清本地）、single-flight refresh、401→刷新→重试一次、<2min 主动刷新、refresh 被拒不盲试、启动恢复 restoreSession、status 带 configured 标记。token 读写异步化后 currentTokens/getStatus/adoptTokens 均为 async；加密失败跳过落盘时内存仍更新（先写盘后缓存不变量的唯一例外，有 log warn）
      entitlement-cache.ts  EntitlementCache — 权益快照 ~/.molio/entitlement-cache.json + 7 天离线宽限（MOLIO_AUTH_GRACE_DAYS 可配）
  routes/
    channel.ts        channelRoutes<TConfig>() 工厂 — 5 个标准渠道路由（status/start/stop/disconnect/config）

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
    maintenance.ts    POST /api/maintenance/rebuild-fts — 重建 FTS 索引（灾难恢复）
    weixin.ts         POST /api/weixin — 微信回调
    feishu.ts         GET/POST /api/feishu/* — 飞书渠道 (status/start/stop/disconnect/config)
    auth.ts           POST /api/auth/start|verify|logout + GET /status + DELETE /account — 云端认证本地镜像（start 原样透传云端响应含 daily devCode；account 注销云端优先，云端不可达抛 502 不清本地）
  publish-bridge/
    bridge-page.ts    发布桥接页面逻辑
test/                  测试用例 (node:test)，按源码模块子目录组织
  core/               config, db, transcript, run-event-buffer, knowledge, conversations, weixin, feishu, auth（mock-cloud.ts 是行为可编程 mock 云端）
  streams/            claude-stream, codex-stream, json-event-stream, jsonl-parser
  runtimes/           env, launch-detection, claude-permission-mode, windows-cmd-resolution
  routes/             agent-test-multiturn, knowledge, publish, sse, feishu
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
| GET | `/api/conversations` | 列出会话历史（支持 ?vaultId=&query=&before=&limit= 游标分页 + 全文搜索 + vault 过滤） |
| GET | `/api/conversations/:id` | 查询单个会话 |
| GET | `/api/conversations/:id/messages` | 列出会话全部消息 |
| DELETE | `/api/conversations/:id` | 删除会话 |
| POST | `/api/conversations/:id/rewind-resend` | 重新生成/编辑重发（回退到末条 user 消息重放建新 run） |
| POST | `/api/conversations/:id/delete-messages` | 按 id 集合删除消息（勾选删除） |
| POST | `/api/maintenance/rebuild-fts` | 重建 messages_fts 索引（灾难恢复） |
| GET/POST/PUT/DELETE | `/api/knowledge` | 知识库管理 |
| POST | `/api/publish` | 发布到内容平台 |
| GET | `/api/graph` | 知识图谱数据 |
| POST | `/api/weixin` | 微信回调 |
| GET | `/api/feishu/status` | 飞书通道状态 |
| POST | `/api/feishu/start` | 启动飞书 WebSocket 长连接 |
| POST | `/api/feishu/stop` | 停止飞书连接（不清理凭证） |
| POST | `/api/feishu/disconnect` | 断开连接并清理 tenant_access_token 缓存 |
| PUT | `/api/feishu/config` | 写 App ID/App Secret/默认 agent（写入 ~/.molio/config.json 的 feishu 字段，自动触发重连） |
| POST | `/api/auth/start` | 发送验证码（转发云端 send-code，响应原样透传，daily/local 含 devCode） |
| POST | `/api/auth/verify` | 验证码登录（注册=登录），token 落 ~/.molio/auth-tokens.json |
| GET | `/api/auth/status` | 登录态快照（离线时 stale=true；refresh 失效 loginExpired=true） |
| POST | `/api/auth/logout` | 云端吊销尽力而为 + 本地必清 token/权益快照 |
| DELETE | `/api/auth/account` | 注销账号：云端软删除 + 吊销全部 session；云端不可达 → 502 且保留本地 token（与 logout 语义相反） |

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
- **Vault 归属**：创建 run 时通过 `body.cwd` → `getVaultByPath` 解析 vault，将 `vault_id` + `vault_name`（反范式化）写入 conversation。vault 删除后 `vault_name` 保留，历史记录仍可显示原名。无 FK 级联——删 vault 不删会话。

## 测试规范

遵循项目根目录 CLAUDE.md 中的**错误驱动测试**规则：每个 bug 在 `test/` 下按源码模块子目录添加复现测试用例。

**目录映射**：测试子目录与 `src/` 源码模块一一对应：
- `test/core/` → `src/core/`（config, db, transcript, RunManager, knowledge, conversations, weixin）
- `test/streams/` → `src/core/streams/`（流解析器）
- `test/runtimes/` → `src/core/runtimes/`（agent 运行时、launch、env）
- `test/routes/` → `src/routes/` + `src/sse.ts`（API 路由、SSE）
- `test/compat/` → 跨模块兼容性检查（ESM、端口检测）