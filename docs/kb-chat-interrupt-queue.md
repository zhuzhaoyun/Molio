# KB 聊天：中断 / 排队机制

> 适用：全局悬浮对话面板（`KbChatSessionsPanel` + `kbChatSessionsStore`，会话标签模型）。
> 记录「任务运行中再次点击入口按钮」时的交互与底层机制，避免重复造轮子。

## 背景

面板常驻 App 层（方案 D：全局悬浮对话，任意页面可用），KB 页不再渲染页内面板。入口按钮经 `chatPanelRef` 下发命令，打开或激活**会话标签**（上限 `MAX_CHAT_SESSIONS` = 10，达上限 toast 拦截）：

- `💬问答`（文档级）→ `kb-btn-ask`：`openQa()` —— 激活/另开 qa 会话标签 + 预载 `@当前文档`/选中文本，**不执行操作**。
- `📚构建Wiki`（vault 级）→ `kb-btn-build-wiki`：`runWikiOp({mode:'build'})` —— **自动发送** skill 提示词，执行操作。
- `🩺健康检查`（vault 级）→ `kb-btn-lint-wiki`：`runWikiOp({mode:'lint'})`，同 wiki 类，自动发送。
- `ingest`（树右键「加入 Wiki」）：`runWikiOp({mode:'ingest', filePath, isDirectory})`，同 wiki 类，自动发送。

`ChatSessionMode = 'qa' | 'build' | 'lint' | 'ingest'`。`runWikiOp` 先「找/建该 mode 的 wiki 会话标签」，再判断冲突；`openQa` 直接激活 qa 标签。

## 核心分情况

当**任意 wiki 任务正在回复中**（`anyWikiRunning === true`，存在非 qa 且 `runningMap[sessionId]` 的会话）时，再次点击入口按钮：

| 入口 | 行为 | 原因 |
|------|------|------|
| `💬问答` | **不中断**——激活/另开 qa 标签 + 预载 `@当前文档` | 问答不是操作，不启动 run；用户 Enter 发送时走正常 send（有 run 在跑就多轮 follow-up，没就新建） |
| `📚`/`🩺`/`ingest` | 弹 3 按钮确认：**中断并立即执行 / 排队等当前完成 / 取消** | 这些会自动发送、启动新任务，需要用户决定如何处理在跑的 run |

> **会话标签语义**（新模型特有）：运行中的会话**切走后台保活**（面板常驻、SSE 不断，切页面/收起面板不中断）；运行中切历史会话 → **另开新标签**保留直播，不就地中断（`handleOpenConversation`）；关闭运行中会话：qa 标签 → 「中断并关闭 / 后台继续并关闭」，wiki 标签 → **只有「中断并关闭 / 取消」**（`closePendingIsWikiRef` 守卫——wiki 不支持后台继续，杜绝已移除标签的 run 逃过 `anyWikiRunning` 单例守卫，防 D3 并发写同一 vault）。

### 💬问答：为什么不中断

`openQa()` 只激活 qa 标签 + 预载上下文，**不 reset、不 cancel**。在跑的 run 继续跑，对话消息保留。用户随后输入 + Enter：

- 有 `existingRunId` 且 agent 未变 → `useChatCore.send` 走多轮 `api.sendMessage(runId, text)`，作为后续消息进入同一 run。
- 否则 `createRun` 新建 run。

所以问答本身永远不触发中断判断。

## 排队机制：对接运行时，不造轮子

「排队等当前完成」**不引入 React 层的 pendingOp / effect 状态机**，直接复用 agent 运行时的原生 stdin 队列。

### 链路

```
runWikiOp(type) 的「排队」分支
  → handleConfirmDialog('queue')
      → 找到正在运行的 wiki 会话，sessionApisRef.get(id).send(prompt)   // KbChatSession → useChatCore.send
          → 有 existingRunId && !agentChanged?
              → api.sendMessage(runId, text)            // POST /api/runs/:id/messages
                  → daemon RunManager.sendMessage(runId, msg)
                      → child.stdin.write(msg + '\n')   // 写入仍在打开的 agent stdin
              → agent（Claude Code 等）自己排队：处理完当前轮，再处理这条
              → 失败（stdin 已关）→ 回退 createRun（见下）
```

排队分支只调 `running.send(prompt)`——**不 reset、不 cancel、不改模式**。提示词作为用户消息立即出现在会话里（排队可见），agent 处理完当前轮后接下一条。

### Pattern A vs Pattern B（运行时差异）

daemon `RunManager` 按 agent 类型分两种 stdin 模式：

- **Pattern A（stream-JSON，如 Claude Code）**：`stdinOpen = true`，stdin 常开。`sendMessage` 写入 stdin，agent 在当前轮结束后处理新消息——**原生多轮队列**。排队在这类 agent 上完全正常。
- **Pattern B（非 stream-json）**：`stdin.end(prompt)` 后关闭，`stdinOpen = false`。`sendMessage` 抛 `Run not active or stdin closed` → `useChatCore.send` catch 后回退 `createRun`——**排队退化为「起一个新 run」**（旧 run 仍跑完，新 run 并行启动）。

> Pattern B 的退化是运行时限制，非前端逻辑问题。主用例 Claude Code 属 Pattern A，排队正常。

### 为什么不造轮子

agent 进程本身就是一个消息处理循环（stdin → 处理 → 下一轮）。在前端再建一个 `pendingOp` + `isRunning` 翻 false 的 effect 去排队，会与 agent 自身的队列重复且不同步（前端不知道 agent 何时处理完）。直接 `sendMessage` 写入 stdin，让 agent 自己调度，是唯一正确的接合点。

## 中断机制

「中断并立即执行」= `handleConfirmDialog('interrupt')`：

```
runWikiOp(type) 的「中断」分支
  → handleConfirmDialog('interrupt')
      → 逐个 cancel 所有真正在跑的 wiki 会话并 await    // Promise.all + .catch
          → api.cancelRun，杀后端 agent 进程
      → 目标 wiki 标签 clearAndSend
          → a.cancel()（await，无 run 时是安全 no-op）→ a.clear() → a.send(prompt)
```

**中断的语义是「停掉正在跑的那个任务」，不是「停掉新任务要落地的那个 tab」**（D3「新构建停旧构建」）。当正在跑的 tab 和新任务 tab 是不同 mode（build 在跑 + 点 lint）时，只 cancel 目标 tab 会落空 → 旧 run 进程没被杀，新旧两个 wiki run 并发写同一 vault（D3 hazard）。所以中断先按 `runningMap` 把所有非 qa 且正在跑的会话全部 cancel 并 `await`，再对目标标签 clear + send。

`clearAndSend` 里 `await a.cancel()` 才 `clear` + `send`，确保 cancel 的收尾 setState 不会覆盖随后新 run 的 running 状态；cancel 的网络失败不中止中断（旧进程可能没杀掉，但 clear + 新 run 照常进行，避免中断无响应）。

## 未挂载会话的补发

新开的 wiki 会话尚未 mount（API 未注册到 `sessionApisRef`）时，`clearAndSend` 把提示词缓存到 `pendingAutoSendRef`，`registerApi` 时补发。不再需要旧的 50ms `setTimeout` 等 state flush 的 hack——`await a.cancel()` 天然避免 stale runId，无需定时器。

## 关键代码位置

| 位置 | 职责 |
|------|------|
| `apps/web/src/components/kb/KbChatSessionsPanel.tsx` `runWikiOp` | 找/建 wiki 会话标签 + `anyWikiRunning` 守卫 → 三选一 |
| 同上 `handleConfirmDialog` | `interrupt`：cancel 全部在跑的 wiki + 目标标签 clear+send；`queue`：send 给在跑会话 |
| 同上 `clearAndSend` | `cancel`（await）→ `clear` → `send` 提示词；未 mount 时缓存 `pendingAutoSendRef` |
| 同上 `openQa` | 问答：激活 qa 标签 + 预载上下文，不 reset、不 cancel |
| 同上 `handleCloseConfirm` / `closePendingIsWikiRef` | 关闭运行中会话确认（wiki 只允许「中断并关闭」，无「后台继续」） |
| 同上 `handleOpenConversation` | 运行中会话切历史 → 另开新标签保留直播（不就地切换） |
| `apps/web/src/components/kb/KnowledgeBasePage.tsx` `handleBuildWiki`/`handleLintWiki`/`handleIngestFile` | 入口：经 `chatPanelRef.runWikiOp` 下发 |
| `apps/web/src/components/kb/KbChatSession.tsx` `registerApi`/`send`/`clear`/`cancel`/`loadConversation` | 会话实例 API（每标签一个，注册到 `sessionApisRef`） |
| `apps/web/src/hooks/useChatCore.ts` `send` | 多轮分支：`existingRunId` → `api.sendMessage`，失败回退 `createRun` |
| `apps/web/src/api/client.ts` `sendMessage` | `POST /api/runs/:id/messages` |
| `apps/daemon/src/core/RunManager.ts` `sendMessage` | 写入 agent stdin（Pattern A）/ 抛错（Pattern B） |

## 测试覆盖

- E2E `apps/web/e2e/kb-chat-entry.spec.ts`：
  - `💬问答 while a build is active opens a separate qa tab — build tab keeps its thread`：运行中再点问答 → 另开 qa 标签、build 标签保留线程（不中断）。
  - `📚构建Wiki opens chat + auto-sends`：非运行态直接执行。
  - `🩺健康检查 disabled when wiki not initialized`：未初始化禁用入口。
- 中断/排队弹窗的 `anyWikiRunning` 触发态在无真实 agent 的测试环境非确定，靠逻辑 + 代码审查保证；前端不造独立队列，故无需单独测排队状态机。
