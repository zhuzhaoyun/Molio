# dsh-plugin-molio — DeepSeek Harness 的 Obsidian 与本地知识库插件

[![npm version](https://img.shields.io/npm/v/dsh-plugin-molio.svg)](https://www.npmjs.com/package/dsh-plugin-molio)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.5-blue)](https://github.com/deepseek-ai/dsh)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

**把你的本地 Obsidian 库与 Markdown 笔记，直接装进 DeepSeek Harness（DSH）。**

不用再把攒了上千篇的 Obsidian 笔记来回复制粘贴进对话框。安装 `dsh-plugin-molio` 后，DSH 左侧栏原生多出 **「知识 · 图谱 · 资源」** 三个工作台视图：直接打开任意本地 Obsidian Vault 或 Markdown 文件夹，点一下「问答」就把笔记挂入对话，AI 回复里的 `[[双链]]` 点开即看右侧 Obsidian 属性预览，还能一键定回原笔记。

> Powered by [Molio](https://github.com/zhuzhaoyun/Molio) —— 本地优先的 AI 知识工作台。插件首次访问时按需拉起本地知识服务，停用即退，与原生 Molio 桌面版默认共享同一本地数据目录。

---

## 为什么选择它？

- **零配置直连 Obsidian Vault**
  无需在 Obsidian 里折腾第三方桥接插件，也不必打开 Obsidian 客户端——直接选中本地 Vault 目录（或任意 Markdown 文件夹）即可使用。原生解析 `[[双链]]`、`[[笔记|别名]]` 与 YAML Frontmatter 属性（类型、标签、别名、相关笔记、来源等）。
- **DSH 侧栏原生三视图，切页保活不丢进度**
  基于官方 DSH 公开客户端插槽构建，左侧栏提供 **「知识」**（目录树与多标签阅读）、**「图谱」**（全库引用关系网络）、**「资源」**（领域知识包与技能市场）。切换侧栏或对话再切回时，已打开的文档标签与阅读位置完整保留。
- **笔记即上下文，每条结论都可溯源**
  打开笔记点 **「问答」**，当前文档自动作为附件加入对应知识库会话（选中片段自动转为引用），输入框留给你的真实问题。AI 回答与右侧 Obsidian 预览中的 `[[双链]]` 均可点击展开，属性区支持折叠与标签自适应换行，点右上角 **「在知识库中打开」** 直接跳回原笔记。
- **读全库零负担，写入库有边界**
  内置 5 个只读 Agent 工具，AI 可自由检索、浏览与精读全库而不会误改原文；需要沉淀对话成果时，通过输入框 **「＋ → 文件入库」** 选择目标知识库与来源生成草稿，经你确认后再执行落盘。

---

## 快速安装

环境要求：Node.js `>= 24`，DeepSeek Harness `>= 0.2.2-rc.5`。

### 方式一：命令行直接从 npm 安装（推荐）

默认环境安装：

```sh
dsh plugin add dsh-plugin-molio
```

指定 DSH Web 或自定义 profile 安装：

```sh
dsh plugin --profile web add dsh-plugin-molio
```

### 方式二：DSH 桌面版安装

打开官方 DSH 桌面版的 **插件管理**，添加 `dsh-plugin-molio`（或从 [GitHub Releases](https://github.com/zhuzhaoyun/Molio/releases) 下载对应版本的 `dsh-plugin-molio-*.tgz` 离线包导入），重启对应 profile 即可生效。

---

## 三步上手工作流

1. **挂载你的 Obsidian 库 / 本地笔记目录**
   点击左侧栏 **「知识」** → **「打开知识库」**，通过系统目录选择器选中你的本地 Obsidian Vault 或 Markdown 文件夹，索引自动在后台建立（大目录树支持按需懒挂载，多库秒切）。
2. **基于笔记提问与双链穿行**
   - 在笔记页点 **「问答」** 发起带上下文的对话；
   - 点击 AI 回答或正文里的 `[[笔记名]]` / `[[笔记名|别名]]`，在右侧 **Obsidian 预览面板**查看可折叠属性与正文，继续顺着相关笔记深读，或点 **「在知识库中打开」** 回到主视图；
   - 点击左侧栏 **「图谱」** 查看全库引用结构，或进入 **「资源」** 浏览导入现成知识与技能包。
3. **安全沉淀回知识库**
   在任意对话输入框点 **「＋」 → 「文件入库」**，选择目标知识库（知识库路径下的工作区会自动匹配）与来源文件，点击 **「生成入库草稿」**，审阅无误后发送执行。

---

## v0.2.4 更新亮点

- **面板与标签保活**：在「知识 · 图谱 · 资源」与对话间来回切换时保留 DOM 状态与已打开的文档标签，不再重置阅读位置。
- **切换与大库性能跃升**：优化知识库切换链路、大目录树懒挂载以及内置 sidecar / SQLite 语句缓存与关停清理，大体积 Obsidian Vault 响应更顺滑。
- **Obsidian 右侧预览打磨**：顶部 YAML 属性区支持一键折叠，长标签与多条 `[[相关笔记]]` 引用按侧栏宽度自动换行并可直接点击跳转，右上角支持一键定回知识库原文。
- **桌面原生交互补齐**：接入宿主系统目录选择器，点「问答」自动挂载当前笔记附件并保留干净输入框。

---

## 内置 Agent 工具清单（全部只读）

安装插件后，DSH 会话中的 Agent 自动获得以下 5 个只读工具：

| 工具名 | 参数 | 用途说明 |
|---|---|---|
| `molio_status` | — | 检查本地知识服务健康状态与当前激活的知识库 |
| `molio_kb_vaults` | — | 列出全部已接入的 Obsidian / 本地知识库 |
| `molio_kb_tree` | `vaultId?` | 获取知识库目录树（省略时默认使用当前激活库） |
| `molio_kb_search` | `query`, `vaultId?`, `limit?` | 全文检索笔记标题与内容，返回命中路径与上下文摘录 |
| `molio_kb_read` | `path`, `vaultId?`, `force?` | 读取笔记原文；二进制文件返回类型说明，超大文件需 `force: true` |

> `vaultId` 既支持传知识库 ID，也支持直接传知识库名称（忽略大小写；存在同名库时工具会提示改用 ID）。

---

## 进阶配置：连接独立部署 / NAS 服务

默认情况下，插件在首次访问时自动在本机启动内置知识服务，无需额外安装或手工启动守护进程。如果你已经在本地、Docker 或 NAS 上独立运行了 Molio 服务，可通过环境变量指定（对 `dsh` 进程生效）：

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `MOLIO_DAEMON_URL` | 外部 Molio 服务的完整地址（需同时提供 Web 页面与 API） | 按需启动本机内置服务 |
| `MOLIO_PORT` | 指定本机已运行的 Molio daemon 端口 | — |

---

## 本地构建与开发验证

本包位于 [Molio monorepo](https://github.com/zhuzhaoyun/Molio) 的 `packages/dsh-plugin-molio` 目录，在仓库根目录使用 Node.js 24 与 pnpm 构建：

```sh
pnpm install --frozen-lockfile
pnpm build:contracts
pnpm --filter dsh-plugin-molio build
pnpm --filter dsh-plugin-molio test
node --test packages/dsh-plugin-molio/test/bundle.test.mjs
cd packages/dsh-plugin-molio && npm pack
```

生成的 `.tgz` 包含宿主入口、DSH 浏览器客户端、Molio Web 视图、内置知识库服务与技能。在临时 DSH Web profile 安装打包产物并启动后，可将实例地址传入 `MOLIO_DSH_SMOKE_URL`，运行端到端宿主联调测试：

```sh
MOLIO_DSH_SMOKE_URL=http://127.0.0.1:<port> node --test packages/dsh-plugin-molio/test/official-host.mjs
```

## License

与 Molio 主仓库一致：修改版 Apache License 2.0（详见 [LICENSE](./LICENSE)）。
