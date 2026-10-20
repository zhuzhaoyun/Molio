# @molio/cli

Molio 知识库能力 CLI + MCP server。把 [Molio](https://github.com/zhuzhaoyun/Molio) 本地知识库（vaults / 文件树 / 读取 / 搜索 / AI 问答）暴露给外部桌面 agent（腾讯 WorkBuddy、千问等）与 shell 脚本调用。

**本包是 Molio daemon（默认 `http://127.0.0.1:3100`）的薄 HTTP 客户端，不含任何知识库逻辑。** 使用前请先启动 Molio 桌面版（或 `@molio/daemon`）。

全部能力**只读**：vaults / tree / read / search / AI 问答。不提供写入、导入、删除。

## 安装与运行

```bash
npx -y @molio/cli status        # 免安装即用（需 Node.js >= 20）
npm install -g @molio/cli       # 或全局安装后使用 molio 命令
```

## CLI 命令

```
molio status                                # daemon 健康 + 当前知识库
molio kb vaults [--json]                    # 知识库列表
molio kb tree [--vault <id|name>] [--json]  # 文件树
molio kb read <relPath> [--vault X] [--force] [--json]   # 读文件（--force 跳过大小限制提示）
molio kb search <query> [--vault X] [--limit N] [--json] # 全文搜索
molio kb ask <question> [--vault X] [--agent <id>] [--timeout 120] [--async] [--json]  # AI 问答（流式）
molio kb result <runId> [--wait] [--timeout 120] [--json]  # 查询/等待异步问答结果
molio mcp                                   # 启动 stdio MCP server（7 tools）
```

- `--vault` 支持 id 精确匹配或名称忽略大小写匹配；缺省使用 Molio 当前选中的知识库。
- 数据输出到 stdout（`--json` 时为单个 JSON 值），日志与错误输出到 stderr。
- 环境变量：`MOLIO_DAEMON_URL`（完整覆盖 daemon 基址）、`MOLIO_PORT`（默认 3100）。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | daemon 不可达 / 中途断连且 run 状态未知 |
| 2 | 知识库未找到、名称歧义、无当前知识库且未传 `--vault` |
| 3 | 文件不存在 |
| 4 | 文件过大 |
| 5 | 参数缺失/非法、无可用 agent runtime |
| 6 | run 终态 failed/canceled，或 run 丢失 |
| 7 | `--timeout` 到期 run 仍未终止 |

## MCP server

```bash
molio mcp
```

stdio 传输，注册 7 个只读 tools：`molio_status`、`kb_vaults`、`kb_tree`、`kb_read`、`kb_search`、`kb_ask_start`、`kb_ask_poll`。

- `kb_ask_start` 立即返回 `{runId, ...}`；`kb_ask_poll{runId}` 单次查询返回 `{status, answer?}`，由调用方按 ≥5s 间隔轮询（适配 MCP 30s 超时约束）。
- 所有错误以 `isError: true` + 可读中文消息返回，不抛 JSON-RPC 异常。

任意 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "molio-kb": {
      "command": "npx",
      "args": ["-y", "@molio/cli", "mcp"]
    }
  }
}
```

## 前置条件

- Node.js >= 20
- Molio 桌面版或 daemon 正在运行（默认端口 3100）
- `kb ask` 需要机器上已安装至少一个可用的 AI runtime（如 Claude Code）

## License

见仓库根目录 [LICENSE](https://github.com/zhuzhaoyun/Molio/blob/main/LICENSE)（修改版 Apache 2.0，含附加条件）。
