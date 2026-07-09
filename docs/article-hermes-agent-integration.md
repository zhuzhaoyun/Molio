# 给 Molio 接入第五个 AI 运行时：Hermes 与 ACP 协议的落地笔记

> 基于 commits `bff786c`（feat: integrate Hermes Agent via ACP）与 `4365cf7`（fix: ACP transport hardening + bump prompt idle timeout），以及设计稿 `docs/hermes-agent-design.md`。
> Issue: #98
> 日期: 2026-07-01

## 一、起因：四个同质 agent 之后，来了个异类

Molio 的 Runtime 模块在此之前已经接了四个 AI CLI：Claude Code、Codex、Qwen Code、Gemini CLI。它们的进程模型惊人地一致——**一次性 spawn**：往 stdin 投一段 prompt，stdout 流式吐 JSONL，进程干完活自己退出。多轮对话？要么每次新开进程，要么靠 stream-json 模式让进程别退、继续往 stdin 写。

这套模型统一到极致，`RunManager` 里就一个 `selectParser` 分发到不同的 stream handler，逻辑闭合。

然后 Hermes 来了。

[Nous Research](https://github.com/NousResearch/hermes-agent) 开源的 self-improving agent，跟前面四位都不一样：它是一个**长驻 JSON-RPC server**。Spawn 之后进程不退出，多轮对话靠 RPC 调用 `session/prompt` 完成，输出通过 `session/update` notification 主动推送回来。

这意味着原先那条 stdin→stdout 单向流解析的链路，对 Hermes 完全不适用。

## 二、关键发现：Hermes 自带 ACP 入口

最早的设计稿想过两条路：

1. **复用 stdin-prompt 模板**：调用 `hermes -q "question"` 这种单问模式。
2. **接 ACP 适配器**：Hermes 的 `pyproject.toml` 里暴露了一个叫 `hermes-acp` 的 console script。

第一条路很快被否——`hermes -q` 输出的是 rich TUI 文本（带 ANSI 转义），不是结构化事件，Molio 的 ToolCard、ThinkingBlock 全得废掉。

第二条路是关键发现。Hermes 仓库里有个 `acp_adapter/` 目录，专门把 TUI 逻辑剥离，暴露一个**无 TUI 的 JSON-RPC server** 入口。ACP（Agent Client Protocol）是 Zed 主推的标准 agent 协议——JSON-RPC 2.0 over stdio，newline-delimited 帧。Hermes 把日志全走 stderr，stdout 干干净净只跑 RPC。**这就是为 Molio 这类外部客户端准备的官方接入点。**

## 三、Windows 探测：本以为要 WSL2，结果原生能跑

设计初稿里写过一个 "Windows 上 disable Hermes 按钮 + 提示需 WSL2" 的兜底方案。

实际在 Windows 11 上跑了一遍：`hermes --version` → `0.17.0`，`hermes-acp --version` → `0.17.0`，spawn 之后进程长驻、stdio 正常、newline JSON framing 工作。Hermes 的 PowerShell iex 安装器会建 venv + `.exe` shim，路径在 `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes-acp.exe`，PATH 里直接能找到。

**结论**：无需 WSL2，无需 wsl.exe bridge，无需 Windows disable UI。设计稿里的 disable 方案直接删掉。

## 四、协议探测：从"我应该这么调"到"它实际这么回"

设计阶段我列了一堆未决点：`sessionId` 谁生成？`initialize` 要不要传 `protocolVersion`？`session/new` 的 `mcpServers` 是 list 还是 object？

写了个探测脚本，本地 spawn `hermes-acp.exe` + 真实 RPC 往返，全部确认了：

- `initialize` 必须传 `protocolVersion: 1`，缺了直接 `-32602 Invalid params`
- `session/new` 的 `mcpServers` 是 **list**（`[]`），传 `{}` 报 `list_type` 校验错
- `sessionId` 由 **agent 生成**（UUID），client 不传
- `session/new` 是**慢调用**：3.5s+（加载 51 个插件 + 连 provider），要单独长超时，不能跟 `initialize` 共用
- 用未知 sessionId 调 `session/prompt`，agent **不报 error，直接返回 `stopReason: 'refusal'`**——Molio 端必须自己保证 sessionId 持有正确，不能依赖 RPC error 兜底

这些细节光看 schema 源码是看不出来的，必须真实跑一遍。设计稿里专门有一节叫"协议验证结论（本地探测）"，把这些实测修正全部钉死。

## 五、架构决策：新增 AcpTransport，而不是塞进 selectParser

最大的设计决策是：**ACP 路径不进 `selectParser`**。

`selectParser` 处理的是单向流——stdout 进、AgentEvent 出。ACP 是双向 RPC——要写 stdin 发 request、等 response、还要处理 agent 主动推送的 notification。这是两种范式，硬塞进同一套抽象会拧巴。

所以新建了一个 `AcpTransport` class（`apps/daemon/src/core/streams/acp-transport.ts`），接口很简洁：

```typescript
class AcpTransport {
  feed(chunk)              // stdout 喂入，按 \n 切帧
  request(method, params) // 发 JSON-RPC request，返回 Promise<result>
  notify(method, params)  // 发 notification
  markCancelled(sessionId)// 标记 cancel，后续 notification 丢弃
  rejectAll(error)        // 进程退出时拒绝所有 pending
}
```

整个不变式浓缩成一句：**1 Molio run = 1 ACP session = 1 hermes-acp 进程**。

RunManager 在 `createRun`/`sendMessage`/`cancelRun`/`submitToolResult` 四个入口按 `transport: 'acp-jsonrpc'` 字段分叉，stdio-jsonl 路径完全不动，现有四个 agent 零影响。

## 六、turn 边界的简化

ACP 给的一个意外礼物是 turn 边界。

Claude Code 的 stream-json 模式下，要靠在流里找 `type: 'result'` + `stop_reason` 来判断 turn 结束，挺脆。

ACP 的 `session/prompt` 是一个 JSON-RPC request——**turn 结束 = 这个 request 的 Promise resolve**，`stopReason` 直接在 response 里。期间 agent 通过 `session/update` 推送的所有 `agent_message_chunk` / `tool_call_progress` 事件，全部在 await 期间经 `feed()` → `mapUpdate()` → `onEvent()` 流入 Molio 的事件管线。

request/response 边界就是 turn 边界，比流式推断干净多了。

## 七、踩坑笔记

### 坑 1：60s idle timeout 杀掉了 OCR

上线后第一个 bug。Hermes 跑 OCR 工具时，OCR 是 subprocess，输出走的是 OCR 自己的 stdout/stderr，**hermes 主进程在工具执行期间零输出**。50 页 OCR 要 2-3 分钟，原本 60s 的 idle timer 直接把 run 杀在半路。

修法：把 `promptIdleTimeoutMs` 从 60s 提到 5min，`absoluteTimeoutMs` 从 5min 提到 30min。

但更深的修法是**活动驱动的 idle timer**——超时不基于绝对时间，而是基于"距离上次 stdout/stderr 输出多久"。只要 agent 还在动，就重置计时器。冷启动慢（加载 51 个插件）也没关系，只要还在打印日志就续命。

### 坑 2：close handler 把中途崩溃误判成成功

进程退出码 0 时，原逻辑直接标记 `succeeded`。但如果有 prompt 正在 in-flight，进程退出 code 0 也意味着 prompt 没完成——run 实际上失败了。

修法：close handler 检查 `transport.hasPending()` + `isCancelled(sessionId)`：cancelled → `canceled`；mid-prompt crash → `failed`；否则才看 exit code。

### 坑 3：fake-hermes-acp.mjs 没有 exec bit

macOS CI 挂了。原因是测试 fixture `fake-hermes-acp.mjs` 提交时 mode 是 100644（无执行位），spawn() 在 unix 上没法用 shebang 启动它。`chmod +x` 到 100755 修好。

Windows 上不会出这个 bug，因为 Windows 不靠 shebang——所以这是只在 macOS CI 上才会暴露的隐藏雷。

### 坑 4：stderr 刷屏

Hermes 的 stderr 会刷大量 `INFO`/`WARNING`/`DEBUG` 日志（插件注册、provider 连接、MCP 工具注册、check_fn 失败……）。原有 RunManager 把所有非 codex 的 stderr emit 成 `error` 事件，对 Hermes 会让 UI 被日志刷爆。

修法：ACP 路径加 hermes 专属 stderr 过滤——行首匹配 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(INFO|WARNING|DEBUG)\]` 的丢弃，只保留 `[ERROR]` 和 Python traceback。

## 八、模型列表：从静态下拉到动态填充

设计初稿把"模型选择 UI"推到了 Phase 2，理由是"detectAgents 不 spawn，拿不到 session 信息"。

实测后发现错了。`session/new` 的 response 直接带 `models.availableModels`（20+ 个模型）+ `currentModelId`。**第一次 run 之后就能拿到真实模型列表**，不用推到 Phase 2。

实现上新增了一个 `models` AgentEvent variant，RunManager 在 `session/new` resolve 后通过 SSE 把模型列表推给前端，`useAgents` hook 把它合并进 `AgentInfo`，模型选择器拿到后就动态替换掉静态的 `fallbackModels`。第一次 run 前是占位模型，第一次 run 后自动变成真实列表。

## 九、测试策略：mock 子进程 + 真实 smoke

测试是这次工作量最大的一块。

**单元测试**（`acp-transport.test.ts`）覆盖：
- JSON-RPC 帧切分（含半行截断拼接）
- request/response 配对 + 超时
- cancel 后到达的 notification 丢弃
- 进程退出时 rejectAll
- 10MB buffer cap 防 OOM

**集成测试**（`hermes-acp-integration.test.ts`）写了个 `fake-hermes-acp.mjs` mock 子进程，覆盖：
- 完整流程（initialize → session/new → session/prompt → turn_end）
- 多轮
- cancel 中途丢弃
- idle timeout
- slow-init 配合 stderr heartbeat（验证活动驱动 timer）
- 进程退出 mid-prompt
- submitToolResult 在 ACP 路径下直接 throw

**agents 测试路由**：ACP agent 用 120s 预算 + 只验握手（拿到 `models` 事件即过），不跑完整 LLM turn。理由是 LLM latency 高度依赖环境，跟"hermes 是否装好"无关，跑完整 turn 会让"测试"按钮因无关原因误报红。

## 十、回推的过度设计

ChatGPT review 阶段提了一堆"加架构层"的建议，大部分被回推了：

- ❌ `NormalizedAgentEvent` 新类型 → 复用现有 `AgentEvent` 够了
- ❌ `HermesProcessManager`（health check / zombie cleanup / session recovery）→ Phase 1 用 `child.on('exit')` + daemon 已有 `cancelAll()` shutdown 钩子就够
- ❌ EventEmitter 风格的 `on('session/update')` → 内部一个 callback 函数就够
- ❌ "multi-protocol runtime mesh / 状态一致性层" → 实际不变式就一句"1 run = 1 session = 1 process"，这是注释，不是架构层
- ❌ framing sniff 探测器 → 已验证就是 newline JSON，不做 sniff，但加一个 smoke test

回推理由都是一样的：**这些是 Phase 2 才需要的东西，Phase 1 提前建就是过度设计**。先把不变式实现到极致，等真正有第二个 ACP agent 或者多 session 共享进程的需求时再抽象。

## 十一、最终落点

最终改动 1897 行，新增 16 个文件，涉及 6 个包：

- `packages/contracts`：`RuntimeAgentDef` 加 `transport` + `acp` 字段，新增 `models` AgentEvent
- `apps/daemon`：`AcpTransport` class、`hermes.ts` runtime def、RunManager 四处分叉、stderr 过滤
- `apps/web`：RuntimePage 加 Hermes 图标、`useChatCore` fan-out `models` 事件、`useAgents` 合并模型列表
- 测试：AcpTransport 单元 + RunManager ACP 集成 + fake-hermes-acp fixture

Hermes 成为 Molio 的第五个 AI 运行时，也是第一个走双向 RPC 协议的。`AcpTransport` 这个抽象层以后还能接其他 ACP 兼容的 agent——Zed 推的协议正在被更多 agent 实现，这次接入相当于给 Molio 提前铺好了路。

下次再接入 ACP agent，只需要写一个几十行的 runtime def，不用再碰 transport 层。

---

**一句话总结这次接入**：先用探测脚本把协议细节钉死，再用最小抽象实现不变式，最后用 mock 子进程覆盖所有边界 case。三步走完，线上稳了。
