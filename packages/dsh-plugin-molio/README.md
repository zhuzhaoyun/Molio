# dsh-plugin-molio

让 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh) 直接读取你的 [Molio](https://github.com/zhuzhaoyun/Molio) 本地知识库：在 dsh 对话中列出知识库、浏览文件树、全文搜索、读取原文，AI 基于你的积累做研究、写作与问答。

全部工具**只读**——插件不会修改你的知识库。

## 前置条件

1. Molio 桌面端（或 Docker/NAS 部署）已启动，其本地 daemon 默认监听 `http://127.0.0.1:3100`
2. Molio 中已创建至少一个知识库（vault）
3. dsh `>= 0.2.0-rc.2`

## 安装

```bash
dsh plugin add dsh-plugin-molio
```

或在 profile 中安装：

```bash
dsh plugin --profile <你的profile> add dsh-plugin-molio
```

### 连接远程 / 非默认端口的 daemon

通过环境变量覆盖（对 dsh 进程生效）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `MOLIO_DAEMON_URL` | daemon 完整地址（远程/NAS/Docker 部署用） | — |
| `MOLIO_PORT` | 本机 daemon 端口 | `3100` |

## 工具清单

| 工具 | 参数 | 说明 |
|---|---|---|
| `molio_status` | — | daemon 健康状态 + 当前激活知识库 |
| `molio_kb_vaults` | — | 列出全部知识库 |
| `molio_kb_tree` | `vaultId?` | 知识库文件树（缺省用激活知识库） |
| `molio_kb_search` | `query`, `vaultId?`, `limit?` | 全文搜索，返回命中路径与摘录 |
| `molio_kb_read` | `path`, `vaultId?`, `force?` | 读取文本文件；二进制文件返回说明；过大文件需 `force:true` |

`vaultId` 既可传知识库 id，也可传名称（忽略大小写；重名时工具会提示改用 id）。

## 使用示例

在 dsh 会话中直接说：

> 用 molio_kb_search 在我的知识库里搜「分布式事务」，然后用 molio_kb_read 读最相关的那篇，总结要点。

## 错误处理

daemon 未启动时，工具返回可操作的中文提示（例如「无法连接 Molio 守护进程…请确认 Molio 已启动，或用 MOLIO_DAEMON_URL 指定地址」），不会抛裸异常。

## 开发

本包是 [Molio monorepo](https://github.com/zhuzhaoyun/Molio) 的成员（`packages/dsh-plugin-molio`），零运行时依赖：

```bash
pnpm --filter dsh-plugin-molio build   # tsc → dist/
pnpm --filter dsh-plugin-molio test    # node:test + 假 daemon HTTP 集成测试
```

## License

与 Molio 主仓库一致：修改版 Apache License 2.0（附加条件见 [LICENSE](./LICENSE)）。
