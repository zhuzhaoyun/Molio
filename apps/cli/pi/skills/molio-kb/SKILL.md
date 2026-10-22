---
name: molio-kb
description: Query the user's local Molio knowledge base (read-only) — list vaults, browse the file tree, full-text search, read documents, and run grounded AI Q&A over the user's own notes. Use when the user mentions "我的知识库" / "Molio", or asks to look up, summarize, or answer from material they have collected.
license: MIT
compatibility: Requires the Molio desktop app running locally (daemon on :3100) and the `molio` MCP server registered (the @molio/cli Pi package extension registers it automatically; otherwise `pi mcp add molio -- npx -y @molio/cli mcp`).
metadata:
  version: 0.1.0
  author: Molio
---

# Molio 知识库（molio-kb）

当用户提到「我的知识库」「Molio」，或要求"在我积累的资料里查/总结/回答"时，使用本技能。
所有能力来自 MCP server `molio` 的 7 个工具，**全部只读**，不会修改用户知识库。

## 如何调用

Pi 默认以 **codemode** 方式暴露 MCP 工具：写一段 JavaScript 交给 `codemode` 工具执行，
server `molio` 的工具在脚本里是 `tools.mcp__molio__<tool>`（QuickJS 沙箱，支持顶层 await）：

```js
const res = await tools.mcp__molio__kb_search({ query: "飞书 卡片", limit: 10 });
// ⚠️ 结果是标准 MCP CallToolResult：业务数据是 JSON 字符串，放在 content[0].text 里，
// 必须 JSON.parse；没有 structuredContent，直接取 res.vaults / res.hits 会得到 undefined。
if (res.isError) {
  text("工具报错: " + res.content[0].text);
} else {
  const data = JSON.parse(res.content[0].text);
  text(JSON.stringify(data));
}
```

不确定参数时用 `describeNamespace("molio")` 查看全部工具声明。
若用户把 `molio` 的 exposure 改为 `direct`，则它们也是普通的 `mcp__molio__*` 工具，直接调用即可。

## 可用工具（7 个）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `molio_status` | 连通性自检：daemon 健康 + 当前激活知识库 | 无 |
| `kb_vaults` | 列出全部知识库（id、名称、文件数、路径）+ 当前激活库 | 无 |
| `kb_tree` | 某知识库的完整文件树 | `vaultId?` |
| `kb_search` | 全文搜索，返回文件路径 + 上下文摘录 | `query`、`vaultId?`、`limit?`(1..100，默认 20) |
| `kb_read` | 按相对路径读文本文件内容 | `path`、`vaultId?`、`force?` |
| `kb_ask_start` | 基于知识库发起 AI 问答，**秒回** `{runId}` | `question`、`vaultId?`、`agentId?` |
| `kb_ask_poll` | 单次查询问答结果 `{status, answer?}` | `runId` |

`vaultId` 均可传知识库 **id 或名称**；不传则用 Molio 当前打开的知识库。

## 标准工作流

### A. 查找资料（快，秒级）

1. 不确定用户有哪些库时先 `kb_vaults`（多库场景让用户选，单库直接用）。
2. `kb_search` 搜关键词 → 命中列表（路径 + 摘录）。一次脚本里可对多个关键词
   `Promise.allSettled` 并行搜索，只把命中的路径与摘录 `text()` 出来，避免撑爆上下文。
3. 对最相关的 1~3 个文件用 `kb_read` 读原文，再组织回答。
4. 想了解库的整体结构时用 `kb_tree` 浏览目录，挑文件再 `kb_read`。

### B. AI 问答（慢，10 秒~2 分钟）

适合"总结/综述/对比/基于全部资料回答"类问题：

1. `kb_ask_start({ question })` → 立即拿到 `runId`（不要期待这一步返回答案）。
2. **等待 ≥5 秒**后调 `kb_ask_poll({ runId })`：
   - `status` 为 `pending`/`running` → 继续等 5~10 秒再查，重复；
   - `status` 为 `succeeded` → `answer` 即完整答案，整理后回复用户；
   - `status` 为 `failed`/`canceled` → 返回错误信息，向用户说明。
3. 沙箱内没有定时器，**不要在单个 codemode 脚本里死循环轮询**——每次脚本只做一次
   `kb_ask_poll`，轮询节奏由你跨多次工具调用控制。
4. 总等待建议不超过 3 分钟；超时告知用户"问答仍在后台执行，稍后可再查"。

## 错误场景与恢复

| 现象（isError 消息） | 原因 | 你应该做的 |
|---|---|---|
| 「无法连接 Molio 守护进程…」 | Molio 桌面版未运行 | 提示用户启动 Molio 桌面版后重试；可先 `molio_status` 验证 |
| 工具根本不存在 / server 未连接 | 未安装本包或未注册 MCP server | 让用户运行 `pi mcp add molio -- npx -y @molio/cli mcp`（或 `pi install npm:@molio/cli`）后 `/reload` |
| 「未找到知识库「X」」/「有多个匹配」 | vaultId 名称打错或重名 | `kb_vaults` 列出候选，用 **id** 重试 |
| 「没有打开的知识库」 | Molio 未激活任何库 | 提示用户在 Molio 中打开一个知识库，或显式传 `vaultId` |
| 「文件不存在: X」 | 路径打错 | `kb_tree`/`kb_search` 确认真实相对路径后重试 |
| 「文件过大…」 | 超过读取上限 | 确有需要时带 `force: true` 重试一次；仍失败则改用 `kb_search` 摘要 |
| 「二进制文件（image/png…）」 | 不是文本 | 告知用户该文件是图片/附件，无文本内容 |
| 「本机没有检测到可用的 AI runtime」 | 未装 Claude Code/Codex 等 | 提示用户在 Molio 桌面版「运行时」页安装，或改用工作流 A |
| `kb_ask_poll` 返回「run 不存在或已过期」 | Molio 重启过 | 重新 `kb_ask_start` 发起一次 |

## 回答规范

- 引述知识库内容时注明来源文件路径，方便用户回 Molio 查看原文。
- 搜索结果被截断（返回 `truncated: true`）时，可调大 `limit`（最大 100）或换更精确的关键词。
- 本技能只读：不要向用户承诺"写入/修改/整理知识库文件"。
