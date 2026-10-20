# @molio/cli — 知识库能力 CLI + MCP server

把 Molio 本地知识库能力暴露给**外部桌面 agent**（腾讯 WorkBuddy、千问等）调用的独立包。一套 `DaemonClient` HTTP 内核，双出口：

- **`molio kb ...` CLI 子命令** — 给 shell 型 agent / 脚本用（`status`、`kb vaults/tree/read/search/ask/result`）。
- **`molio mcp` stdio MCP server** — 给 WorkBuddy 连接器用（MCP + Skill 接入方式），7 个只读 tools。

**红线**：

1. **第一版全部只读 + AI 问答**（vaults / tree / read / search / ask）。不做 write / import / delete——最小权限，易过连接器审核。不要向用户承诺"写入/修改/整理知识库"。
2. **CLI 是 daemon（Hono `:3100`）的薄 HTTP 客户端，不含任何知识库逻辑**。路径穿越防护、编码检测、二进制识别、大文件拒绝、回收站等安全逻辑**全在 daemon 侧**，CLI 只做参数解析 + HTTP 调用 + 输出格式化。改 CLI 前先确认该逻辑是不是应该在 daemon。
3. 所有面向外部 agent 的错误都通过**语义化退出码**（CLI）或 **`isError:true` + 可读中文消息**（MCP）表达，不靠解析文本。

## 技术栈

- **运行时**: Node.js `>=20`（WorkBuddy 托管运行时是 Node 20 系）。`tsconfig` 把 `target`/`lib` 覆盖为 **ES2022**——不要用 Node 22+ 独有 API；**无全局 `EventSource`**，SSE 用手写 `sse-parser.ts` 解析 `fetch` body 的 `ReadableStream`。
- **MCP**: `@modelcontextprotocol/sdk` `^1.32.1`（`McpServer` + `StdioServerTransport`）。tool `inputSchema` 用 zod，peer 允许 `^3.25 || ^4.0`。
- **共享类型**: `@molio/contracts`（`workspace:*`，**devDependency**）——`AgentEvent`、`RunInfo`、`RunStatus`、`ChatMessage` 等。**不重复定义**。**只允许 `import type`**（编译后擦除）：contracts 运行时依赖 `better-sqlite3` 原生模块，若进 dependencies 会让 `npx -y @molio/cli` 的用户装原生依赖。新增 contracts 引用必须是 `import type`，否则发布包体积/安装失败风险回归。
- **HTTP**: 全局 `fetch`（Node 20 内置），零 HTTP 库。
- **参数解析**: `node:util` 的 `parseArgs`（仓库无 commander 先例，零新依赖）。
- **测试**: `node:test`，编译后跑 `dist/test/**/*.test.js`；`FakeDaemon`（`node:http` 假 daemon）驱动集成测试。

## 目录结构

```
src/
  index.ts          #!/usr/bin/env node 入口；runCli(argv) 分发 + 退出码收敛（导出供测试）
  version.ts        CLI_VERSION（与 package.json version 手动同步）
  daemon-client.ts  全部 daemon 端点封装 + DaemonError{code,status,message} + isTerminalStatus/lastAssistantText
  sse-parser.ts     手写 SSE 帧解析（跨 chunk 半帧、ping 跳过、关流、UTF-8 多字节）
  vault-resolver.ts --vault id|name → Vault；缺省走 active-vault；agent 解析（显式/第一个 available）
  exit-codes.ts     退出码常量（EXIT_OK..EXIT_TIMEOUT，见下表）
  output.ts         输出层：可注入 sinks（stdout/stderr）+ out/outJson/outRaw/errLine/errLog + 表格/树渲染
  errors.ts         daemonErrorMessage(err) —— CLI 与 MCP 双端共用同一套中文错误文案
  read-service.ts   读文件内核（CLI kb read + MCP kb_read 共享）：text/binary 判定、404→3、413→4
  ask-service.ts    问答内核：startAsk / pollAsk / streamAsk（同步流式）/ waitAsk（轮询）
  commands/         status.ts + kb.ts（路由）+ kb-vaults/tree/read/search/ask/result.ts + types.ts
  mcp/
    server.ts       createMcpServer(client) 工厂（注册 7 tools）+ runMcpServer()（连 stdio）
    tools/          common.ts（toolOk/toolText/toolError/runTool）+ 7 个 registerXxx
connector/          WorkBuddy 提交资产（见下节）
test/               fake-daemon.ts + helpers.ts + sse-parser/vault-resolver/daemon-client/ask-service/commands/mcp-tools 测试
```

## 命令面

```
molio status                                # daemon 健康 + active vault
molio kb vaults [--json]
molio kb tree [--vault <id|name>] [--json]
molio kb read <relPath> [--vault X] [--force] [--json]
molio kb search <query> [--vault X] [--limit N] [--json]
molio kb ask <question> [--vault X] [--agent <id>] [--timeout 120] [--async] [--json]
molio kb result <runId> [--wait] [--timeout 120] [--json]
molio mcp                                   # stdio MCP server（7 tools）
```

- **输出约定**：数据 → stdout（`--json` 时是单个 JSON 值）；日志/错误 → stderr。`ask` 同步模式流式增量走 `outRaw`（不加换行）。
- **环境变量**：`MOLIO_DAEMON_URL`（完整覆盖基址，测试用）、`MOLIO_PORT`（默认 3100）。

## 退出码（外部 agent 决策依据）

| 码 | 常量 | 含义 |
|---|---|---|
| 0 | `EXIT_OK` | 成功 |
| 1 | `EXIT_DAEMON_UNREACHABLE` | daemon 不可达 / 中途断连且 run 状态未知 |
| 2 | `EXIT_VAULT_NOT_FOUND` | vault 未找到、名称歧义、无 active 且未传 `--vault` |
| 3 | `EXIT_FILE_NOT_FOUND` | 文件不存在（daemon 404） |
| 4 | `EXIT_FILE_TOO_LARGE` | 文件过大（413，或 200 + `tooLarge:true`） |
| 5 | `EXIT_USAGE` | 参数缺失/非法、无可用 agent runtime |
| 6 | `EXIT_RUN_FAILED` | run 终态 failed/canceled，或 run 丢失 |
| 7 | `EXIT_TIMEOUT` | `--timeout` 到期 run 仍未终止 |

MCP tool 侧同语义转为 `isError:true` + 可读中文消息（如「无法连接 Molio 守护进程，请确认 Molio 正在运行」）。

## Vault 解析规则（vault-resolver.ts）

`--vault`/`vaultId` 先按 **id 精确**、再按 **name 忽略大小写**匹配；多个同名 → 列候选退出 2；未传 → active-vault；无 active → 提示并退出 2。`POST /api/runs` 的 `cwd` **必须精确等于 `vault.path`**（daemon `getVaultByPath` 是 SQL 精确匹配）——一律用 GET vaults 返回的 `path`，不要自己拼。

## ask 流程（核心设计）

- **同步（默认）**：解析 vault → 选 agentId（`--agent` 优先，否则 `GET /api/agents` 取第一个 available，无则退出 5）→ `POST /api/runs`（cwd=vault.path）→ 立即订阅 SSE，`text_delta` 实时 `outRaw`，`error` 事件写 stderr 但不中断 → 流关闭后 `GET /api/runs/:id` 确认终态：succeeded 且一个字都没流出 → 回退 `GET /api/conversations/:id/messages` 取最后 assistant 消息；failed/canceled → 退出 6。`AbortSignal.timeout(--timeout*1000)` 控总时长，超时退出 7。SSE 中途断连（daemon 重启）→ `GET run` 一次：仍非终态 → 提示用 `kb result` 跟进退出 1；404 → run 丢失退出 6。
- **异步**：`--async` 只 `POST run` 打印 `{runId, conversationId}` 退出 0。`kb result <runId>` 单次查状态（非终态且无 `--wait` → 打印状态退出 0），终态后走 **GET messages 取最后 assistant 消息**（**不碰 SSE**，规避缓冲 drain 后不可回放问题）；`--wait` 时 2s 间隔轮询。
- **MCP 映射（30s 约束）**：`kb_ask_start` 秒回 `{runId, conversationId, ...}`；`kb_ask_poll{runId}` **单次查询**返回 `{status, answer?}`，**handler 内部绝不轮询**——由调用方 agent 按 ≥5s 间隔重复调用。其余 tools 均单次 HTTP，天然 30s 内。

## MCP tools（7 个，全只读）

`molio_status` / `kb_vaults` / `kb_tree{vaultId?}` / `kb_read{path, vaultId?, force?}` / `kb_search{query, vaultId?, limit?(1..100)}` / `kb_ask_start{question, vaultId?, agentId?}` / `kb_ask_poll{runId}`。

`createMcpServer(client)` 是工厂（注入 `DaemonClient`），测试用 SDK `InMemoryTransport` 链接真 `Client` ↔ server。`runTool(fn)` 包装每个 handler，异常一律转 `isError`，**绝不让异常穿透 JSON-RPC**。

## 连接器资产（connector/，WorkBuddy 提交件）

```
connector-meta.json   source=molio-kb（全局唯一 kebab-case）、type=mcp、examples_zh/en、minWorkbuddyVersion=5.0.0
mcp.json              npx -y @molio/cli mcp + runtime node 20 + npmmirror + timeout 30000
icon.svg              64x64 透明背景（打开的书 + AI 气泡点）
skills/molio-kb/SKILL.md   frontmatter 必填 description/description_zh/description_en/version/author(+category)；正文覆盖 7 tools 用法 + 两条工作流 + 错误恢复表
```

⚠️ **提交硬前置**：`mcp.json` 用 `npx -y @molio/cli mcp` 在用户机现装 → **@molio/cli 必须先发布到 npm**（发布管线见下节，已建好；实际发布需 npm @molio scope + 仓库 `NPM_TOKEN` secret 两个一次性人工步骤）。未发布前本地验证用 `node <abs>/dist/src/index.js mcp`。**WorkBuddy 接入无需注册 OAuth 应用**——连接器走「开放平台入驻（资质认证）+ 打包目录提交审核」，OAuth 那套是反方向（Molio 调 WorkBuddy API）才用。

## npm 发布（.github/workflows/cli-publish.yml）

- **触发**：push tag `cli-v*`（如 `cli-v0.1.0`）或手动 workflow_dispatch。与桌面端 `v*`（release.yml）互不干扰。
- **版本校验**：tag 版本 == `apps/cli/package.json` version == `src/version.ts` CLI_VERSION，三者不一致直接 fail。**发版先改两处版本号、commit，再打 tag**。
- **预发布**：version 含 `-`（如 `0.2.0-beta.1`）自动发到 `beta` dist-tag，latest 只留正式版（`npx -y @molio/cli` 装 latest）。
- **流水线步骤**：install → 版本校验 → build contracts → `pnpm --filter @molio/cli test`（自带 rebuild dist）→ NPM_TOKEN guard → 拷根 LICENSE 进包 → `npm pack --dry-run` 公示内容 → `pnpm publish` → registry 回查。
- **一次性人工前置**：① npm 注册 `@molio` scope（组织）；② 仓库 Settings → Secrets 加 `NPM_TOKEN`（automation token，需 @molio 发布权限）。
- **发布内容**：`dist/src`（含 .d.ts）+ `connector/` + README + LICENSE，约 45 kB / 91 文件；运行时依赖仅 `@modelcontextprotocol/sdk` + `zod`。

```bash
# 发版流程
git tag cli-v0.1.0 && git push origin cli-v0.1.0
```

## 命令

```bash
pnpm dev          # tsx src/index.ts（本地跑命令）
pnpm build        # tsc → dist/
pnpm start        # node dist/src/index.js
pnpm test         # rm dist && tsc && node --test dist/test/**/*.test.js（--test-timeout=30000）
pnpm typecheck    # tsc --noEmit
```

## ⚠️ 三个实测坑（改代码前必读）

1. **contracts dist 先行**：`@molio/cli` 测试吃 `@molio/contracts` 的 `dist`。改了 `packages/contracts` 后必须先 `pnpm --filter @molio/contracts build`（或根 `pnpm build`）再跑 cli 测试，否则类型/运行时报错。CI 的 `pr-check.yml` 已在 test 前先 `pnpm build`，本地手动跑时容易忘。
2. **所有命令层输出必须走 `output.ts` 的 `sinks`，绝不能直写 `process.stdout`/`process.stderr`**。`node:test` 的报告器**也写 `process.stdout`**——若测试用 `captureOutput` patch `process.stdout.write`，前一测试的 test:start/test:fail 二进制事件会延迟刷进下一测试的捕获窗口，导致断言拿到乱码（本轮 `kb result` 测试实测踩坑）。解法：`output.ts` 暴露可注入的 `sinks` 对象，命令用 `out/outJson/outRaw/errLine/errLog`，`helpers.ts` 的 `captureOutput` **换 sinks** 而非 patch `process.stdout`。新增任何命令/tool 输出一律走这些函数。
3. **zod 必须 `>=3.25.76`**：`zod@3.25.0` 的 npm 包**缺 `dist/`**（上游打包 bug，`files` 声明了 `dist` 却没发上去），tsc 报 `Cannot find module 'zod'`。`3.25.76` 是扁平布局（`index.d.ts` 在包根），正常。别手滑降版本。

## 测试策略（node:test，遵循仓库「集成测试要求」）

- `test/fake-daemon.ts`：`node:http` 假 daemon，覆盖 health/vaults/active-vault/tree/files(404/413)/search/agents/runs/conversations-messages/events(真实 SSE 帧 + ping + 终态关流)。可编排 run 状态（`RunScript`：events/finalStatus/conversationMessages）、注入延迟、模拟断连（`destroyEventStreams`）与正常关流（`endEventStreams`）。
- `test/helpers.ts`：`startHarness()`（起 FakeDaemon + 注入 `MOLIO_DAEMON_URL`）、`captureOutput`（换 sinks）、`runCliCaptured`、`expectCliError`。
- 单测：sse-parser（跨 chunk 半帧、多字节 UTF-8、ping、关流）、vault-resolver（id/name/歧义/缺省/agent）、daemon-client（各端点 + 不可达 + 错误映射 + 纯函数）。
- 集成：ask-service（startAsk/pollAsk/streamAsk/waitAsk，含超时不泄漏、断连降级、run 丢失）、commands（runCli 端到端断言 stdout + exit code，含全部负面用例）、mcp-tools（InMemoryTransport 真 Client，断言 isError + 中文消息）。
- **mock 行为而非只 mock 返回值**：驱动 pending→succeeded/failed 状态流转，验证负面行为（超时/断连/丢失）。

## 后续（不在本包首版）

write/import 写入 tools、CLI+Skill 备选方案（cli.json + device flow，需 apps/cloud 配合）、千问桌面端实测、WorkBuddy 开放平台提交（硬前置：npm 首发完成）。
