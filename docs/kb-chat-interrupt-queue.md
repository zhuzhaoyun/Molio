# KB 聊天：中断 / 排队机制

> 适用：知识库页面的统一聊天面板（`useKbChat` + `KbChatPanel`）。
> 记录「任务运行中再次点击入口按钮」时的交互与底层机制，避免重复造轮子。

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

## 排队机制：对接运行时，不造轮子

「排队等当前完成」**不引入 React 层的 pendingOp / effect 状态机**，直接复用 agent 运行时的原生 stdin 队列。

### 链路

```
queueWikiOp(type)
  → chatRef.current.send(WIKI_PROMPTS[type])        // useKbChat
  → useChatCore.send(text)
      → 有 existingRunId && !agentChanged?
          → api.sendMessage(runId, text)            // POST /api/runs/:id/messages
              → daemon RunManager.sendMessage(runId, msg)
                  → child.stdin.write(msg + '\n')   // 写入仍在打开的 agent stdin
          → agent（Claude Code 等）自己排队：处理完当前轮，再处理这条
          → 失败（stdin 已关）→ 回退 createRun（见下）
```

`queueWikiOp` / `queueIngest` 只调 `chat.send(prompt)`——**不 reset、不 cancel、不改 mode**。提示词作为用户消息立即出现在对话里（排队可见），agent 处理完当前轮后接下一条。

### Pattern A vs Pattern B（运行时差异）

daemon `RunManager` 按 agent 类型分两种 stdin 模式：

- **Pattern A（stream-JSON，如 Claude Code）**：`stdinOpen = true`，stdin 常开。`sendMessage` 写入 stdin，agent 在当前轮结束后处理新消息——**原生多轮队列**。排队在这类 agent 上完全正常。
- **Pattern B（非 stream-json）**：`stdin.end(prompt)` 后关闭，`stdinOpen = false`。`sendMessage` 抛 `Run not active or stdin closed` → `useChatCore.send` catch 后回退 `createRun`——**排队退化为「起一个新 run」**（旧 run 仍跑完，新 run 并行启动）。

> Pattern B 的退化是运行时限制，非前端逻辑问题。主用例 Claude Code 属 Pattern A，排队正常。

### 为什么不造轮子

agent 进程本身就是一个消息处理循环（stdin → 处理 → 下一轮）。在前端再建一个 `pendingOp` + `isRunning` 翻 false 的 effect 去排队，会与 agent 自身的队列重复且不同步（前端不知道 agent 何时处理完）。直接 `sendMessage` 写入 stdin，让 agent 自己调度，是唯一正确的接合点。

## 中断机制

「中断并立即执行」= `openWikiOp(type)`（或 `openIngest`）：

```
openWikiOp(type)
  → reset()
      → 清 timerRef（见下）
      → if (chat.isRunning) chat.cancel()   // api.cancelRun，杀后端 run
      → conversationIdRef = null
      → setMode(null)
      → chat.reset()                        // 关 SSE + 清空消息
  → setMode(type)
  → setTimeout(50ms, chatRef.current.send(prompt))  // 新 run
```

`chat.cancel()` 调 `api.cancelRun(runId)`，daemon 终止 agent 进程，无泄漏。

## 50ms 延迟与快速连点

`openWikiOp`/`openIngest` 用 `setTimeout(50ms, chatRef.current.send)` 等 `reset()` 的 state 更新 flush 后再发（`chatRef` 拿最新 `chat`，避免 stale `runId`）。

`reset()` 里会 `clearTimeout(timerRef.current)`——否则在 50ms 内从 wiki 切到问答（或关闭面板）会让待触发的 wiki 提示词误发进新线程。`openQa` 不 reset 所以不碰 timer，但它也不排定时器，无影响。

## 关键代码位置

| 位置 | 职责 |
|------|------|
| `apps/web/src/hooks/useKbChat.ts` `openQa` | 问答：只 setMode，不 reset |
| 同上 `openWikiOp`/`openIngest` | 中断路径：reset + 自动发 |
| 同上 `queueWikiOp`/`queueIngest` | 排队路径：直接 chat.send（走 sendMessage stdin 队列） |
| 同上 `reset` | 清 timer + cancel + 清消息（中断/切换/关闭共用） |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` `confirmRunningOp` | 3 按钮确认弹窗（中断/排队/取消） |
| 同上 `handleOpenWikiOp`/`handleIngestFile` | `isRunning` 守卫 → 直接执行 or 弹确认 |
| `apps/web/src/components/kb/KbModals.tsx` `ConfirmDialog` | 通用确认弹窗，`tertiaryLabel`+`onTertiary` 支持第三按钮 |
| `apps/web/src/hooks/useChatCore.ts` `send` | 多轮分支：`existingRunId` → `api.sendMessage`，失败回退 `createRun` |
| `apps/web/src/api/client.ts` `sendMessage` | `POST /api/runs/:id/messages` |
| `apps/daemon/src/core/RunManager.ts` `sendMessage` | 写入 agent stdin（Pattern A）/ 抛错（Pattern B） |

## 测试覆盖

- E2E `apps/web/e2e/kb-chat-entry.spec.ts`：
  - `💬问答 while a build is active does NOT interrupt — keeps thread + seeds @当前文档`：问答不 reset、build 消息保留 + `@当前文档` 预载。
  - `📚构建Wiki opens chat + auto-sends`：非运行态直接执行。
- 中断/排队弹窗的 `isRunning` 触发态在无真实 agent 的测试环境非确定，靠逻辑 + 代码审查保证；前端不造独立队列，故无需单独测排队状态机。
