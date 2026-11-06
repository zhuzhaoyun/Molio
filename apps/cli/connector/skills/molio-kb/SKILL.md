---
description: Query the user's local Molio knowledge base — browse files, full-text search, read documents, and run AI Q&A grounded in the user's own notes (read-only).
description_zh: 查询用户本机 Molio 知识库——浏览文件树、全文搜索、读取原文，并基于用户自己的积累做 AI 问答（全部只读）。
description_en: Query the user's local Molio knowledge base — browse files, full-text search, read documents, and run AI Q&A grounded in the user's own notes (read-only).
version: 0.1.0
author: Molio
category: knowledge
---

# Molio 知识库（molio-kb）

当用户提到「我的知识库」「Molio」，或要求"在我积累的资料里查/总结/回答"时，使用本技能。
所有工具都通过 MCP server `molio-kb` 提供，**全部只读**，不会修改用户知识库。

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
2. `kb_search` 搜关键词 → 命中列表（路径 + 摘录）。
3. 对最相关的 1~3 个文件用 `kb_read` 读原文，再组织回答。
4. 想了解库的整体结构时用 `kb_tree` 浏览目录，挑文件再 `kb_read`。

### B. AI 问答（慢，10 秒~2 分钟）

适合"总结/综述/对比/基于全部资料回答"类问题：

1. `kb_ask_start(question)` → 立即拿到 `runId`（不要期待这一步返回答案）。
2. **等待 ≥5 秒**后调 `kb_ask_poll(runId)`：
   - `status` 为 `pending`/`running` → 继续等 5~10 秒再查，重复；
   - `status` 为 `succeeded` → `answer` 即完整答案，整理后回复用户；
   - `status` 为 `failed`/`canceled` → 返回错误信息，向用户说明。
3. 总等待建议不超过 3 分钟；超时告知用户"问答仍在后台执行，稍后可再查"。

**绝不**在一次 `kb_ask_poll` 里期待阻塞等待——它永远单次返回，轮询节奏由你控制。

## 错误场景与恢复

| 现象（isError 消息） | 原因 | 你应该做的 |
|---|---|---|
| 「无法连接 Molio 守护进程…」 | Molio 桌面版未运行 | 提示用户启动 Molio 桌面版后重试；可先 `molio_status` 验证 |
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
