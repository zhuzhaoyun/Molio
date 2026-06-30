# KB 聊天：中断 / 排队机制

> 适用：知识库页面的统一聊天面板（`useKbChat` + `KbChatPanel`）。
> 记录「任务运行中再次点击入口按钮」时的交互与底层机制。排队用前端 pending 列表（不接 agent stdin 队列），理由见下。

## 背景

KB 页面右侧统一聊天面板由 `useKbChat` 驱动（包 `useChatCore`），入口按钮按**作用域**分布：

- `💬问答`（文档级）→ `kb-main-header`：只激活面板 + 预载 `@当前文档`，**不执行操作**。
- `📚构建Wiki` / `🩺健康检查`（vault 级）→ `KbTabBar` 尾部 `actions`：**自动发送** skill 提示词，执行操作。
- `ingest`（树右键「加入 Wiki」）：同 wiki 类，自动发送。

`useKbChat` 的 `mode`：`'qa' | 'build' | 'lint' | 'ingest' | null`。mode 由入口决定，面板无模式条。

## 核心分情况

当聊天**正在回复中**（`kbChat.isRunning === true`，一个 run 在跑）时，再次点击入口按钮：

| 入口 | 行为 | 原因 |
|------|------|------|
| `💬问答` | **不中断**——只切 mode='qa' + 预载 `@当前文档` | 问答不是操作，不启动 run；用户 Enter 发送时走正常 send（有 run 在跑就多轮 follow-up，没就新建） |
| `📚`/`🩺`/`ingest` | 弹 3 按钮确认：**中断立即执行 / 排队等当前完成 / 取消** | 这些会自动发送、启动新任务，需要用户决定如何处理在跑的 run |

### 💬问答：为什么不中断

`openQa()` 只 `setMode('qa')`，**不 reset、不 cancel**。在跑的 run 继续跑，对话消息保留。面板因 mode 变化重挂载 `ChatComposer`，预载 `@当前文档`。用户随后输入 + Enter：

- 有 `existingRunId` 且 agent 未变 → `useChatCore.send` 走多轮 `api.sendMessage(runId, text)`，作为后续消息进入同一 run。
- 否则 `createRun` 新建 run。

所以问答本身永远不触发中断判断。

## 排队机制：前端 pending 列表（视觉隔离 + 规避路由错位）

「排队等当前完成」用**前端 pending 列表**，不立即进 `messages` 流：

- `queueWikiOp`/`queueIngest` 把操作 push 到 `useKbChat.queuedOps`（不 send）。
- 面板在 `messages` 与 `composer` 之间渲染独立「排队中」区（pill + × 取消），排队消息**不显示在已发送区域**。
- `isRunning` 由 true→false（`prevRunningRef` 边沿检测）时，shift 首项 → `setMode + chat.send(prompt)`，走 `createRun` 续同一线程（带 history）。

### 为什么不用 agent stdin 队列

agent stdin 队列（`sendMessage` 写入运行中 run 的 stdin）功能上能排队，但 `useChatCore.send` 每次把 `assistantIdRef` 覆盖为新占位 → run 还在跑时再 send，当前 turn 剩余事件会路由到排队占位（`assistantIdRef` 错位），原占位卡 streaming——这是「排队消息看起来像已发送」的根因。前端 pending 列表每次只在上一条完成后才 send，永不同时存在两个竞争占位，顺带规避此 bug。

stdin 多轮 `sendMessage` 仍用于**问答 follow-up**（用户在 run 跑时输入 + Enter）和主页 chat——这些是单条后续消息，不走 wiki 排队路径。

## 中断机制（续线程）

「中断并立即执行」= `openWikiOp`/`openIngest`：

- `if (chat.isRunning) chat.cancel()` —— 关 SSE + `api.cancelRun` 杀后端 run。
- `setMode(type)`。
- `clearTimeout(timerRef); setTimeout(50ms, chatRef.current.send(prompt))` —— 50ms 让 cancel 的 setState flush，send 走 `createRun`（续同一线程，带 history）。

**不 reset、不清消息**——中断续线程，上下文不断。想起新线程走「新对话」按钮（`reset`）。

## 新对话 vs close

- **新对话**（面板头部按钮，复刻主页 `new-chat-btn`）：`reset()` —— 清 `queuedOps` + `timerRef` + cancel + 清 `messages` + `setMode(null)`。唯一的清空入口。
- **close(✕)**：`cancel + 清 queuedOps + 清 timer`，**不清 messages**——关面板=隐藏，对话保留，重开还在。

## 50ms 延迟与快速连点

`openWikiOp`/`openIngest` 用 `setTimeout(50ms, chatRef.current.send)` 等 cancel + setMode 的 state 更新 flush 后再发（`chatRef` 拿最新 `chat`，避免 stale `runId`）。

`reset()` 与 `close()` 都会 `clearTimeout(timerRef.current)`——否则在 50ms 内从 wiki 切到问答、新对话或关闭面板会让待触发的 wiki 提示词误发进新线程。`openQa` 不排定时器，无影响。

## 关键代码位置

| 位置 | 职责 |
|------|------|
| `apps/web/src/hooks/useKbChat.ts` `openQa` | 问答：只 setMode，不 reset |
| 同上 `openWikiOp`/`openIngest` | cancel + send，续线程 |
| 同上 `queueWikiOp`/`queueIngest` | push 到 queuedOps（不 send），完成后 shift |
| 同上 `reset` | 新对话：清 queuedOps + timer + cancel + 清 messages + setMode(null) |
| 同上 `close` | cancel + 清排队，不清 messages |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` `confirmRunningOp` | 3 按钮确认弹窗（中断/排队/取消） |
| 同上 `handleOpenWikiOp`/`handleIngestFile` | `isRunning` 守卫 → 直接执行 or 弹确认 |
| `apps/web/src/components/kb/KbModals.tsx` `ConfirmDialog` | 通用确认弹窗，`tertiaryLabel`+`onTertiary` 支持第三按钮 |
| `apps/web/src/hooks/useChatCore.ts` `send` | 多轮分支：`existingRunId` → `api.sendMessage`，失败回退 `createRun` |
| `apps/web/src/api/client.ts` `sendMessage` | `POST /api/runs/:id/messages` |
| `apps/daemon/src/core/RunManager.ts` `sendMessage` | 写入运行中 agent 的 stdin（stream-json agent）；stdin 已关则抛错 |

## 测试覆盖

- E2E `apps/web/e2e/kb-chat-entry.spec.ts`：
  - `💬问答 while a build is active does NOT interrupt — keeps thread + seeds @当前文档`：问答不 reset、build 消息保留 + `@当前文档` 预载。
  - `📚构建Wiki opens chat + auto-sends`：非运行态直接执行。
- 中断/排队弹窗的 `isRunning` 触发态在无真实 agent 的测试环境非确定，靠逻辑 + 代码审查保证；前端 pending 列表的状态流转由对应单元 / E2E 测试覆盖。
