# Molio × Pi Coding Agent

把 Molio 本地知识库接入 [Pi](https://pi.dev)（Mario Zechner 的极简 coding agent，
Pi ≥ 1.0 原生支持 MCP）。安装后 Pi 获得 7 个**只读**知识库工具：列库 / 浏览文件树 /
全文搜索 / 读原文 / 基于用户积累做 AI 问答。

前置条件：

- **Molio 桌面版正在运行**（daemon 监听 `:3100`；Docker 部署则映射到本机 3100）
- Pi ≥ 1.0（`pi --version` 查看；旧版先升级）
- Node.js ≥ 20（Pi 本身要求 ≥ 22.19）

## 安装（一步）

```bash
# npm 源（@molio/cli 发布到 npm 后可用）
pi install npm:@molio/cli

# 或 git 源 / 本地路径（开发验证）
pi install git:github.com/zhuzhaoyun/Molio.git  # 需仓库根即包根，当前 monorepo 结构请用下面的本地路径方式
pi install D:/path/to/Molio/apps/cli           # 本地安装前先在仓库根 pnpm install && pnpm --filter @molio/cli build
```

安装内容（本目录）：

| 资产 | 作用 |
|---|---|
| `extensions/molio-mcp.ts` | 会话启动时自动注册 `molio` stdio MCP server（拉起本包 `dist/src/index.js mcp`，dist 缺失时回退 `npx -y @molio/cli mcp`） |
| `skills/molio-kb/SKILL.md` | Agent Skills 规范技能：教 Pi 何时/如何用这 7 个工具（含 codemode 调用约定、问答轮询节奏、错误恢复表） |

验证：

```bash
pi list          # 应列出 @molio/cli package
pi --print "调用 molio_status，把结果告诉我"
```

## 不用 Pi package 的手动接入（兜底）

只想要 MCP 工具、不装 package 时，直接注册 server（格式与 Claude Desktop/Cursor 通用）：

```bash
pi mcp add molio -- npx -y @molio/cli mcp   # npm 发布后
pi mcp add molio -- node /abs/path/to/Molio/apps/cli/dist/src/index.js mcp  # 本地构建
pi mcp list                                  # 应显示 molio: connected, 7 tools
```

手动 `mcp.json` 里的同名 `molio` server **优先于**扩展注册（Pi 的覆盖规则），
因此可以用 `pi mcp add` 覆盖包内默认配置（如改 `MOLIO_PORT` 环境变量）。

## 工具一览（全只读）

`molio_status` / `kb_vaults` / `kb_tree` / `kb_read` / `kb_search` /
`kb_ask_start`（秒回 runId）/ `kb_ask_poll`（单次查询，调用方控制轮询节奏）

Pi 中默认以 codemode 暴露：脚本内为 `tools.mcp__molio__kb_search({…})`；
`direct` exposure 下则是普通的 `mcp__molio__*` 工具。详见 `skills/molio-kb/SKILL.md`。
