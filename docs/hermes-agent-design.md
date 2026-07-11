# Hermes Agent 接入设计

> Issue: https://github.com/zhuzhaoyun/Molio/issues/98
> Worktree: `feat/hermes-agent`
> 状态: 设计已定稿 + 本地探测验证，待实现
> 日期: 2026-06-29（设计）/ 2026-06-30（探测修正）

## 一、背景与目标

在 Runtime 模块接入 Hermes Agent（Nous Research 开源的 self-improving AI agent），让用户能在 Molio 中像使用 Claude Code / Codex / Qwen Code / Gemini CLI 一样调用 Hermes。

本地克隆：`D:\code\ai\try\hermes-agent-main`
上游仓库：https://github.com/NousResearch/hermes-agent

## 二、Hermes 与现有 agent 的本质差异

| 维度 | Claude/Codex/Qwen/Gemini | Hermes |
|---|---|---|
| 进程模型 | 一次性 spawn：stdin 投 prompt → stdout 流 JSONL → 进程退出 | 长驻 JSON-RPC server：spawn 后保持运行，多轮通过 RPC 调用 |
| Prompt 投递 | 写入 stdin（text 或 stream-json） | 调用 `session/prompt` JSON-RPC request |
| 输出协议 | JSONL 流（每行一个 event） | ACP JSON-RPC：`session/update` notification（双向，agent→client 推送） |
| 状态 | 无状态（每 turn 独立 spawn 或 stdin 续写） | 有状态 session（`session/new` → 多次 `session/prompt` → `session/cancel`） |
| 二进制 | 原生可执行（npm 分发） | Python 包，console script `hermes` / `hermes-acp` |
| Windows | 原生支持 | **原生支持**（PowerShell iex 安装器建 venv + `.exe` shim，路径 `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes-acp.exe`） |
| 一键安装 | npm-native（已有引擎） | 官方 PowerShell iex / curl-bash 安装器，无法走现有 npm-native 引擎 |

**关键发现**：Hermes 自带 ACP (Agent Client Protocol) 适配器（`acp_adapter/`），console script 是 `hermes-acp`（`pyproject.toml:131`）。ACP 是 Zed 主推的标准 agent 协议（JSON-RPC over stdio），Hermes 已经把 TUI 逻辑剥离，专门暴露了一个无 TUI 的 RPC server 入口，stdout 干净（日志全走 stderr）。**这就是为 Molio 这类外部客户端准备的官方接入点。**

**Windows 探测结论（2026-06-30）**：在 Windows 11 上 `hermes --version` 返回 `0.17.0`、`hermes-acp --version` 返回 `0.17.0`，spawn `hermes-acp` 后进程长驻、stdio 正常、newline JSON framing 工作。**无需 WSL2，无需 wsl.exe bridge，无需 Windows disable UI**。`resolveAgentBinary` 在 PATH 里直接找到 `hermes-acp.exe`（或 fallback `hermes.exe`）。

## 三、接入方式选择

### 否决：复用现有 `RuntimeAgentDef` stdin-prompt 模板

- Hermes 没有像 claude `-p --input-format stream-json` 这种 headless 入口
- `cli.py` 的 `-q "question"` 是单问模式，输出是 rich TUI 文本（ANSI），不是 JSONL
- 拿不到结构化的 `tool_use` / `tool_result` 事件，Molio 的 ToolCard / ThinkingBlock 全废

### 采用：接 ACP 适配器，新增 ACP transport

- Spawn `hermes-acp` 作为长驻子进程
- Daemon 实现一个 ACP JSON-RPC client
- 把 ACP `session/update` notification 映射成 Molio 的 `AgentEvent`
- 多轮天然支持：Molio 收到用户新消息 → 调 `session/prompt` RPC，不需要重启进程

## 四、协议验证结论（本地探测：spawn `hermes-acp.exe` + 真实 RPC 往返）

### 帧格式：newline-delimited JSON ✓

`acp/connection.py:62` 类注释："Minimal JSON-RPC 2.0 connection over newline-delimited JSON frames."
`connection.py:151` 用 `await self._reader.readline()` 读一行 JSON。

**实测**：每条 response/notification 占一行，`feed(chunk)` 按 `\n` 切分即可。现有的 `createJsonlParser`（`apps/daemon/src/core/streams/jsonl-parser.ts`）切分逻辑直接可复用（但 ACP 路径不进 `selectParser`，见第六节）。

### 核心方法的协议形态（实测）

| 方法 | 方向 | 类型 | params | 返回 |
|---|---|---|---|---|
| `initialize` | client → agent | request | **`{ protocolVersion: 1, clientCapabilities: {} }`**（`protocolVersion` 必填，缺了报 `-32602 Invalid params`） | `{ protocolVersion: 1, agentInfo: {name, version}, agentCapabilities, authMethods: [...] }` |
| `session/new` | client → agent | request | `{ mcpServers: [], cwd }`（**`mcpServers` 是 list 必填，传 `{}` 会报 `list_type` 校验错**；`cwd` 可选） | `{ sessionId: "<uuid>", models: {availableModels, currentModelId}, modes: {availableModes, currentModeId}, _meta: {hermes: {sessionProvenance}} }` |
| `session/prompt` | client → agent | **request** | `{ sessionId, prompt: ContentBlock[], messageId? }` | `{ stopReason, usage? }` |
| `session/cancel` | client → agent | **request** | `{ sessionId }` | ack |
| `session/update` | agent → client | **notification** | `{ sessionId, update: { sessionUpdate: <variant_str>, ...fields } }` | — |

**关键修正点**：
1. `initialize` 必须传 `protocolVersion: 1`（设计初稿漏了，实测发现）
2. `session/new` 的 `mcpServers` 是 **list**（`[]`），不是 object
3. `sessionId` 由 **agent 生成**（UUID），client 不传 —— 之前列的未决点 #1 已确认
4. `session/new` 是**慢调用**：实测 3.5s+（加载 51 个插件 + 连 provider），要单独长超时（建议 30s），不能跟 `initialize` 共用 `initializeTimeoutMs`

### `session/new` 返回的额外信息（设计初稿未提及，可利用）

```jsonc
{
  "sessionId": "94e08337-ce65-496b-8fc5-c3f461647e23",
  "models": {
    "availableModels": [
      { "modelId": "alibaba-coding-plan:deepseek-v4-pro", "name": "deepseek-v4-pro", "description": "..." },
      // ... 20+ 个模型
    ],
    "currentModelId": "alibaba-coding-plan:deepseek-v4-pro"
  },
  "modes": {
    "availableModes": [
      { "id": "default", "name": "Default", "description": "Ask before edits." },
      { "id": "accept_edits", "name": "Accept Edits", "..." },
      { "id": "dont_ask", "name": "Don't Ask", "..." }
    ],
    "currentModeId": "default"
  },
  "_meta": { "hermes": { "sessionProvenance": { ... } } }
}
```

→ **模型选择 UI 可以 Phase 1 就做**（设计初稿推到 Phase 2 是错的）：`AgentInfo.models` 动态填充 `availableModels`，比 `fallbackModels` 静态列表更准。`modes` Phase 2 再做（对应"命令审批"流程）。

### `session/update` 分发：按 `update.sessionUpdate` 类型 tag

**实测**：notification 的 `params.update` 是一个对象，**类型 tag 在 `update.sessionUpdate` 字段**（snake_case 字符串），不是 union 直接分发。

```jsonc
// 实测两条 session 启动时主动推送的 notification：
{ "jsonrpc": "2.0", "method": "session/update",
  "params": { "sessionId": "...",
    "update": { "sessionUpdate": "available_commands_update", "availableCommands": [...] } } }

{ "jsonrpc": "2.0", "method": "session/update",
  "params": { "sessionId": "...",
    "update": { "sessionUpdate": "usage_update", "size": 1000000, "used": 13874 } } }
```

→ `mapUpdate(update)` 要先读 `update.sessionUpdate` 字符串，再按值分发。`acp/schema.py:3125` 的 union 变体名（`UserMessageChunk` 等）对应 tag 是 `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call_start` / `tool_call_progress` / `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` / `agent_plan_update`。

**注意 non-turn 事件**：session 启动时 agent 会主动推 `available_commands_update` + `usage_update`，这些不在 turn 期间。`mapUpdate` 要么转成 `status` 事件，要么忽略（Phase 1 建议忽略 `available_commands_update`，`usage_update` 转 `usage` 事件）。

### `StopReason` 取值（`acp/schema.py:14`，实测确认）

```python
StopReason = Literal["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]
ToolCallStatus = Literal["pending", "in_progress", "completed", "failed"]
```

**实测边界 case**：用未知 sessionId 调 `session/prompt`，agent **不报 error，而是返回 `{ stopReason: 'refusal' }`**。意味着 Molio 端必须保证 sessionId 正确持有，不能依赖 RPC error 兜底。

### Turn 生命周期（关键洞察）

`session/prompt` 是 request → **turn 结束 = `PromptResponse` 的 Promise resolve**，不需要靠流里某个事件推断。

```
Molio: await transport.request('session/prompt', { sessionId, prompt })
  │
  ├─ (await 期间) hermes 通过 stdout 推送多条 session/update notification
  │     └─ feed() 逐行解析 → mapUpdate → onEvent({ type: 'text_delta'/'tool_use'/'tool_result'/'thinking' })
  │
  └─ PromptResponse 返回 { stopReason: 'end_turn' }
        └─ onEvent({ type: 'turn_end', stopReason })
```

对比 Claude Code 的 stream-json（要在流里找 `type: 'result'` + `stop_reason` 判定 turn 结束），ACP 的 request/response 边界就是 turn 边界，更简单。

### Cancel 的微妙点

`session/cancel` 是 request，不是 notification。当用户点 cancel 时：
1. Molio 调 `transport.request('session/cancel', { sessionId })` —— 进入 `pending` 表
2. Hermes 收到 cancel，把原 `session/prompt` 的 response 返回（`stopReason: 'cancelled'`）
3. Molio 的 `pending` 表里两个 request 都被 resolve：原 prompt 拿到 `{ stopReason: 'cancelled' }`，cancel 拿到 ack
4. `mapUpdate` 不需要特殊处理 cancel——`turn_end` 自然由 prompt 的 response 触发

**要小心的**：
- cancel 之后到达的 `session/update` notification 要丢弃。`transport` 里加 `cancelledSessionIds: Set<string>`，response resolve 后清掉。
- `cancelRun` 当前是同步 void（`RunManager.ts:382`），ACP cancel 是 async request。改 fire-and-forget + `cancelledSessionIds` 立即标记，**并加超时兜底**：cancel request 5s 未返回则 SIGTERM 杀进程，避免 UI hang。
- `session/cancel` 的 Promise reject（网络错误/进程退出）不能让用户看不到——要 catch 后仍然 SIGTERM 兜底。

### stderr 处理（实测发现）

Hermes stderr 会刷大量 INFO/WARNING 日志（插件注册、provider 连接、MCP 工具注册、check_fn 失败等）。当前 `RunManager.ts:298-311` 的逻辑把所有非 codex 的 stderr emit 成 `error` 事件——对 hermes 会刷屏。

→ ACP 路径要 hermes 专属 stderr 过滤：
- 行首匹配 `^\d{4}-\d{2}-\d{2} .* \[(INFO|WARNING|DEBUG)\]` 的行，丢弃或不 emit
- 只 `[ERROR]` 级别 + Python traceback 才 emit 成 `error` 事件
- 或更简单：ACP 路径下 stderr 全部写日志文件，不 emit 给 UI

### update 变体 → Molio AgentEvent 映射（按 `sessionUpdate` tag）

| `update.sessionUpdate` | Molio AgentEvent |
|---|---|
| `agent_message_chunk` | `text_delta` |
| `agent_thought_chunk` | `thinking_delta` / `thinking_start` |
| `tool_call_start` | `tool_use` |
| `tool_call_progress` | `tool_result`（按 `toolCallId` 关联） |
| `usage_update` | `usage` |
| `session_info_update` | `status` / metadata |
| `available_commands_update` | 忽略（Phase 1） |
| `current_mode_update` / `config_option_update` / `agent_plan_update` | 忽略或 status（Phase 1） |

## 五、对 ChatGPT review 的取舍

### 接受的修正

| 反馈点 | 采纳方式 |
|---|---|
| ACP 是 RPC 不是 stream parser | `acp-transport.ts` 暴露成 class（不是 `StreamHandler`）：`feed(chunk)` 处理 stdout + `send(req): Promise<Resp>` 写 stdin + `onUpdate(cb)` 回调通知。重命名 `acp-stream.ts` → `acp-transport.ts` |
| sessionId binding | `RunState` 加 `acp?: { transport: AcpTransport; sessionId: string }`。1 Molio run = 1 ACP session = 1 hermes-acp 进程，1:1 映射，不建 registry |
| Windows 策略 | ~~disable run 按钮 + 提示需 WSL2~~ → 实测原生支持，**删除 disable**，只加图标 |
| 命名 | `acp-stream` → `acp-transport`，class 名 `AcpTransport` |

### 回推的过度设计

| 反馈点 | 回推理由 |
|---|---|
| 新增 `NormalizedAgentEvent` 类型 | 复用现有 `AgentEvent`（`packages/contracts/src/event.ts`）足够 |
| `HermesProcessManager`（health check / zombie cleanup / session recovery） | Phase 1 不需要。`child.on('exit', ...)` + daemon 已有的 `cancelAll()` shutdown 钩子就够。supervisor 是 Phase 2 |
| `on('session/update', ...)` EventEmitter 风格 | 内部一个 callback 函数就够 |
| "multi-protocol runtime mesh / 状态一致性层" | 实际不变式就一句："1 run = 1 session = 1 process"。这是注释，不是架构层 |
| 1:n session 映射 | Phase 1 只做 1:1。多 session 共享进程是 Phase 2 优化 |
| framing sniff 探测器 | 已验证 = newline JSON，不做 sniff，但加一个 smoke test |

## 六、实现设计

### 文件改动清单

```
packages/contracts/src/agent.ts                       + transport, acp 字段
apps/daemon/src/core/runtimes/hermes.ts               新增
apps/daemon/src/core/runtimes/registry.ts             注册 hermesAgentDef
apps/daemon/src/core/streams/acp-transport.ts         新增 AcpTransport class
apps/daemon/src/core/RunManager.ts                    createRun/sendMessage/cancelRun/submitToolResult 分叉 + stderr 过滤
apps/daemon/src/types.ts                              RunState 加 acp / acpModels 字段
apps/daemon/test/runtimes/acp-transport.test.ts       新增（单元 + 集成测试，mock 子进程）
apps/daemon/test/runtimes/hermes-smoke.test.ts        新增（spawn 真实 hermes-acp，CI skip）
apps/web/src/components/runtimes/RuntimePage.tsx      hermes 图标（无 Windows disable）
```

### `RuntimeAgentDef` 扩展（`packages/contracts/src/agent.ts`）

新增字段：

```typescript
/** Transport mode: one-shot stdin/stdout JSONL vs bidirectional ACP JSON-RPC */
transport?: 'stdio-jsonl' | 'acp-jsonrpc';
/** ACP method mapping — which JSON-RPC methods to call for prompt/cancel */
acp?: {
  promptMethod: 'session/prompt';
  cancelMethod: 'session/cancel';
  initializeTimeoutMs?: number;   // 默认 10s
  sessionNewTimeoutMs?: number;   // 默认 30s（慢调用，加载插件+连 provider）
  cancelTimeoutMs?: number;       // 默认 5s，超时后 SIGTERM 兜底
};
```

默认 `'stdio-jsonl'`，现有 4 个 agent 不受影响。

**字段冗余修正**：不设 `streamFormat: 'acp-jsonrpc'`。`streamFormat` 保持原语义（输出格式），ACP 路径在 `createRun` / `selectParser` 入口就分叉，不进 `selectParser`。单一真相在 `transport` 字段。

### `AcpTransport` 接口

```typescript
// apps/daemon/src/core/streams/acp-transport.ts
export class AcpTransport {
  private buffer = '';
  private pending = new Map<number, { resolve, reject }>();
  private nextId = 1;
  private cancelledSessionIds = new Set<string>();

  constructor(
    private send: (json: string) => void,        // 写 stdin
    private onEvent: (ev: AgentEvent) => void,   // 输出 Molio 事件
  ) {}

  /** stdout 喂入 — 复用 newline JSON 切分逻辑 */
  feed(chunk: string | Buffer): void { /* 切行 → handleLine */ }

  /** 发 JSON-RPC request，返回 response result（支持超时） */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs ?? 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** 主动发 notification */
  notify(method: string, params: unknown): void {
    this.send(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** 进程退出时 reject 所有 pending */
  rejectAll(error: Error): void { /* 遍历 pending.reject */ }

  /** 标记 sessionId 已 cancel，后续 notification 丢弃 */
  markCancelled(sessionId: string): void { this.cancelledSessionIds.add(sessionId); }
  unmarkCancelled(sessionId: string): void { this.cancelledSessionIds.delete(sessionId); }

  private handleLine(line: string): void {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? p?.reject(msg.error) : p?.resolve(msg.result);
    } else if (msg.method === 'session/update') {
      if (this.cancelledSessionIds.has(msg.params?.sessionId)) return;
      this.mapUpdate(msg.params.update);
    } else if (msg.method) {
      // 其他 notification / server-initiated request（request_permission 等）
      // Phase 1 忽略或返回 method_not_found
    }
  }

  private mapUpdate(update: AcpUpdate): void {
    // 实测：类型 tag 在 update.sessionUpdate（snake_case）
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': this.onEvent({ type: 'text_delta', delta: update.chunk }); break;
      case 'agent_thought_chunk': this.onEvent({ type: 'thinking_delta', delta: update.chunk }); break;
      case 'tool_call_start': this.onEvent({ type: 'tool_use', id: update.toolCallId, name: update.toolName, input: update.input }); break;
      case 'tool_call_progress': this.onEvent({ type: 'tool_result', toolUseId: update.toolCallId, content: update.output, isError: update.status === 'failed' }); break;
      case 'usage_update': this.onEvent({ type: 'usage', usage: { /* map fields */ } }); break;
      case 'available_commands_update': break;  // 忽略（Phase 1）
      default: break;  // current_mode_update / config_option_update / session_info_update / agent_plan_update
    }
  }

  flush(): void { /* 处理 buffer 剩余 */ }
}
```

### `RunManager` 集成点（实测修正）

`RunState` 新增 `acp?: { transport: AcpTransport; sessionId: string }` + `acpModels?: { modelId: string; name: string }[]`。

**`createRun` 分叉**（`RunManager.ts:170`）：spawn 后，ACP 路径要真正 await 初始化（当前 `createRun` 是 async 但 spawn 后逻辑同步）：
```typescript
if (def.transport === 'acp-jsonrpc') {
  const transport = new AcpTransport(
    (json) => run.child?.stdin?.write(json, 'utf8'),
    (ev) => this.emitEvent(run, ev),
  );
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => transport.feed(chunk));
  child.on('exit', () => transport.rejectAll(new Error('process exited')));

  try {
    await transport.request('initialize',
      { protocolVersion: 1, clientCapabilities: {} },
      def.acp?.initializeTimeoutMs ?? 10000);
    const session = await transport.request('session/new',
      { mcpServers: [], cwd: opts.cwd },
      def.acp?.sessionNewTimeoutMs ?? 30000);
    run.acp = { transport, sessionId: session.sessionId };
    if (session.models?.availableModels) {
      run.acpModels = session.models.availableModels.map(m => ({ modelId: m.modelId, name: m.name }));
      // 通过 SSE 事件推给前端动态替换模型下拉
      this.emitEvent(run, { type: 'status', label: 'models_ready' /* 或专用事件 */ });
    }
  } catch (err) {
    this.emitEvent(run, { type: 'error', message: `Hermes init failed: ${err.message}` });
    child.kill('SIGTERM');
    this.finishRun(run, 'failed', 1, null);
    throw err;
  }
}
```

**`sendMessage` 分叉**（`RunManager.ts:344`）—— 设计初稿漏了，必须改：
```typescript
sendMessage(runId: string, message: string): void {
  const run = this.runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const def = getAgentDef(run.agentId);

  if (def?.transport === 'acp-jsonrpc') {
    if (!run.acp) throw new Error('ACP session not initialized');
    const { transport, sessionId } = run.acp;
    // fire-and-forget: 事件通过 session/update 流入，turn_end 由 prompt response 触发
    transport.request('session/prompt',
      { sessionId, prompt: [{ type: 'text', text: message }] },
      300000)  // prompt 默认 5min 超时
      .then((resp) => {
        this.emitEvent(run, { type: 'turn_end', stopReason: mapStopReason(resp.stopReason) });
        transport.unmarkCancelled(sessionId);
      })
      .catch((err) => {
        if (!transport.cancelledSessionIds.has(sessionId)) {
          this.emitEvent(run, { type: 'error', message: `prompt failed: ${err.message}` });
        }
      });
    return;
  }

  // 原有 stdin JSONL 路径不变
}
```

**`cancelRun` 分叉**（`RunManager.ts:382`）—— 加超时 SIGTERM 兜底：
```typescript
cancelRun(runId: string): void {
  const run = this.runs.get(runId);
  if (!run) return;
  const def = getAgentDef(run.agentId);

  if (def?.transport === 'acp-jsonrpc' && run.acp) {
    const { transport, sessionId } = run.acp;
    transport.markCancelled(sessionId);  // 立即标记，后续 notification 丢弃
    transport.request('session/cancel', { sessionId }, def.acp?.cancelTimeoutMs ?? 5000)
      .catch(() => { /* cancel 本身失败，走 SIGTERM 兜底 */ })
      .finally(() => {
        if (run.child && !run.child.killed) run.child.kill('SIGTERM');
      });
    return;
  }

  // 原有 SIGTERM+SIGKILL 路径
}
```

**`submitToolResult` 分叉**（`RunManager.ts:358`）：ACP 路径不支持 host tool result（hermes 自己处理 tool 执行），throw：
```typescript
submitToolResult(runId, toolUseId, content) {
  const run = this.runs.get(runId);
  const def = getAgentDef(run.agentId);
  if (def?.transport === 'acp-jsonrpc') {
    throw new Error('ACP transport does not support host tool results — Hermes executes tools internally');
  }
  // 原有路径
}
```

**`selectParser` 不进 ACP**（`RunManager.ts:563`）：`createRun` 里 ACP 路径直接构造 transport + `child.stdout.on('data', transport.feed)`，不调 `selectParser`。

**stderr 过滤**（`RunManager.ts:298-311`）：ACP 路径下 hermes 专属过滤：
```typescript
if (def.transport === 'acp-jsonrpc') {
  // Hermes 日志格式：YYYY-MM-DD HH:MM:SS [LEVEL] logger: msg
  const isLogLevel = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(INFO|WARNING|DEBUG)\]/;
  if (isLogLevel.test(trimmed)) return;  // 丢弃，不 emit
  // 只 ERROR + Python traceback 才 emit
}
```

**stdin 不关闭**：`multiTurn: true` 已让 `maybeCloseStdin` 跳过关闭（`RunManager.ts:527`），ACP 复用此行为，无需额外改。

**进程退出兜底**：`child.on('exit', () => transport.rejectAll(...) + finalizeRun())` + daemon shutdown 时 `cancelAll()`。

### `hermesAgentDef`

```typescript
// apps/daemon/src/core/runtimes/hermes.ts
import type { RuntimeAgentDef } from '@molio/contracts';

export const hermesAgentDef: RuntimeAgentDef = {
  id: 'hermes',
  name: 'Hermes Agent',
  bin: 'hermes-acp',                    // Windows: hermes-acp.exe (venv shim)
  fallbackBins: ['hermes'],             // 'hermes acp' 也可
  versionArgs: ['--version'],
  buildArgs: () => [],                  // hermes-acp 无参
  transport: 'acp-jsonrpc',
  acp: {
    promptMethod: 'session/prompt',
    cancelMethod: 'session/cancel',
    initializeTimeoutMs: 10000,
    sessionNewTimeoutMs: 30000,         // 慢调用，加载插件+连 provider
    cancelTimeoutMs: 5000,
  },
  // 不设 streamFormat: 'acp-jsonrpc'（避免冗余，transport 是单一真相）
  multiTurn: true,
  fallbackModels: [
    { id: 'default', label: 'Default' },
    // 真实模型列表由 session/new 返回的 availableModels 动态填充，覆盖此字段
  ],
  installUrl: 'https://github.com/NousResearch/hermes-agent',
  // Phase 1 不配 install（PowerShell iex / curl-bash 不走 npm-native 引擎）
};
```

注册到 `apps/daemon/src/core/runtimes/registry.ts:7` 的 `AGENT_DEFS`。

### 模型选择（Phase 1 提前，实测修正）

设计初稿把模型选择推到 Phase 2 是错的——`session/new` 直接返回 `models.availableModels` + `currentModelId`。

**实现**：
1. `RunState` 加 `acpModels?: { modelId: string; name: string }[]`
2. `createRun` ACP 初始化后，把 `session.models.availableModels` 存到 `run.acpModels`
3. `detectAgents`（`RunManager.ts:56`）对 hermes 仍返回静态 `fallbackModels`（detectAgents 不 spawn，拿不到 session）
4. 首次 `session/new` 后通过 SSE 事件把 `availableModels` 推给前端动态替换下拉

### Windows 处理（删 disable）

设计初稿的 Windows disable UI **删除**——实测 Hermes 在 Windows 原生可跑（`hermes-acp.exe` venv shim）。`RuntimePage.tsx` 只加 hermes 图标，不做平台 disable。

### StopReason 映射

| ACP `stopReason` | Molio `AgentEvent.turn_end.stopReason` |
|---|---|
| `end_turn` | `'end_turn'` |
| `max_tokens` | `'max_tokens'` |
| `max_turn_requests` | `'max_turn_requests'` |
| `refusal` | `'refusal'`（UI 应展示拒绝原因；**实测**：未知 sessionId 也返回 refusal，Molio 端要保证 sessionId 正确持有） |
| `cancelled` | `'cancelled'` |

## 七、实施分期

### Phase 1（核心可用，本 PR）

1. 扩 `RuntimeAgentDef`：`transport` + `acp` 字段（含三个超时）
2. 新增 `acp-transport.ts`：JSON-RPC client（带超时 + rejectAll + cancelledSessionIds）+ ACP→AgentEvent mapper（按 `sessionUpdate` tag 分发）
3. `RunManager` 分叉：`createRun` await initialize+session/new、`sendMessage` 走 RPC、`cancelRun` 走 session/cancel + 超时 SIGTERM 兜底、`submitToolResult` throw、stderr 过滤、不进 `selectParser`
4. `RunState` 加 `acp` + `acpModels` 字段
5. 新增 `hermes.ts` + 注册
6. 模型列表：`session/new` 返回 `availableModels` 通过 SSE 推给前端动态替换下拉
7. daemon 单元 + 集成测试：mock `hermes-acp` 子进程，覆盖 initialize 超时、cancel 中途丢弃 notification、stdout 半行截断、进程退出 reject pending、cancelledSessionIds 清理
8. smoke test：spawn 真实 `hermes-acp`，发 `initialize`+`session/new`，验响应（CI 上 skip，仅本地手动跑）
9. `RuntimePage.tsx` 加 hermes 图标（**无 Windows disable**）
10. 不配 `install`，仅 `installUrl`

### Phase 2（后续 PR）

- **shell-installer** install source 类型：扩展 `InstallSource` 联合，加 `{ type: 'shell-installer', command: string, ... }`，支持一键安装（PowerShell iex / curl-bash）
- **ACP permission 协议打通**：Molio Phase 1 默认 auto-allow（对齐其他 agent 的 `--dangerously-skip-permissions` 思路），ACP 的正式做法是 client 回 `allow_always` / `allow_once`。Phase 2 实现"命令审批 UI"
- **session 持久化**：Hermes 自己用 `~/.hermes/state.db` 存 session，Molio 可以暴露"切换 session"UI
- **`HermesProcessManager`**：health check / zombie cleanup / session recovery / 多 session 共享进程
- **modes 选择 UI**：`session/new` 返回 `modes.availableModes`（default / accept_edits / dont_ask），Phase 2 接到 UI

## 八、风险与未决点

1. ~~**`session/new` 的 `sessionId` 生成方**~~ **已确认**：agent 生成（UUID），client 不传。
2. ~~**模型选择 UI**~~ **已提前到 Phase 1**：`session/new` 返回 `availableModels`，动态填充。
3. **`request_permission` 流程**：Hermes 可能会主动发 `session/request_permission` RPC（如执行 bash 前）。Phase 1 默认 auto-allow，影响"命令审批 UI"，留 Phase 2。
4. **ACP schema 版本**：`acp_adapter/server.py` 用了 `use_unstable_protocol=True`，协议还在演进。Molio 端 TS 实现（自己写，`agent-client-protocol` 是 Python 包，TS 侧无官方实现）需锁定 schema 版本（当前 `PROTOCOL_VERSION = 1`，schema ref `v0.11.2`）。
5. **进程清理**：长驻进程如果 daemon 崩溃会变孤儿。daemon 启动时扫一遍清理（Phase 2），Phase 1 依赖 `cancelAll()` shutdown 钩子。
6. **`session/prompt` 实测未拿到 response**：探测脚本 15s timeout 内没收到 prompt response（LLM 调用慢）。编码时 prompt 超时设 5min，并验证 response 到达后 `turn_end` 正确触发。

## 九、不变式（架构约束）

> 1 Molio run = 1 ACP session = 1 hermes-acp 进程

这是 Phase 1 的核心约束，所有设计都基于此。Phase 2 才考虑 1:n 的 session 共享进程优化。
