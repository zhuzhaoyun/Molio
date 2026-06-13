# Molio (墨流)

> 知识工作者的本地 AI 工作台：管理知识库 → 调用本地 AI 写作 → 一键排版发布，全程数据不出境

**[English](README_EN.md)** | 中文

Molio 将知识库管理、AI 辅助写作和多平台发布串联为一体，是一款**本地优先**的桌面应用。所有数据存储在本地，通过编排 Claude Code、OpenAI Codex、Gemini CLI、Qwen Code 等本地 AI 运行时完成文档创作，内容无需上传到云端。

## 核心功能

- **知识库管理** — 基于类 LLM_Wiki 的自管理知识库，支持文件树浏览、创建、编辑、删除，自动构建可检索的知识网络
- **AI 辅助写作** — 通过本地 AI 运行时进行文档创作，支持多轮对话、工具调用、流式输出
- **多运行时编排** — 支持 Claude Code / OpenAI Codex / Gemini CLI / Qwen Code，一键切换
- **项目上下文加载** — AI 进程自动加载项目目录下的 `CLAUDE.md`、内置的 `wiki_prompt` 以及文档结构
- **Markdown 排版** — 集成 [doocs/md](https://github.com/doocs/md) 排版引擎，支持微信公众号等平台格式化
- **多平台发布** — 配合 [doocs/cose](https://github.com/doocs/cose) 一键发布到 30+ 内容平台
- **本地优先，数据私有** — 所有数据存储在本地，AI 运行时直接调用本地 CLI，文档内容无需上传云端

## 界面预览

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/img/main.png" alt="首页" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>AI 对话：选择 Agent 发送消息，支持流式响应</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/img/wiki_knowledge.png" alt="知识库" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>Vault 文件树管理，Markdown 渲染与浏览</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/img/Layout%20.png" alt="排版编辑器" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>左右分栏实时预览，主题/字体/颜色可调</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/img/publish.png" alt="多平台发布" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>一键同步到 30+ 内容平台</sub>
    </td>
  </tr>
</table>

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite 6 + TypeScript |
| 后端 | Hono + Node.js + SQLite (better-sqlite3) |
| 桌面 | Electron 40 + electron-builder |
| 构建 | pnpm workspace monorepo |
| 测试 | node:test (内置) |

## 项目结构

```
Molio/
├── packages/
│   └── contracts/       @molio/contracts — 共享类型定义
├── apps/
│   ├── daemon/          @molio/daemon   — Hono HTTP 服务端 (API + SSE)
│   ├── web/             @molio/web      — Vite + React 前端
│   └── desktop/         @molio/desktop  — Electron 桌面壳
└── package.json         monorepo 根配置
```

## 快速开始

### 前置要求

- **Node.js** >= 22
- **pnpm** >= 9
- 至少安装一个 AI 运行时 CLI：
  - [Claude Code](https://claude.ai/claude-code)
  - [OpenAI Codex CLI](https://github.com/openai/codex)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [Qwen Code](https://github.com/QwenLM/qwen-code)

### 安装与运行

```bash
# 克隆项目
git clone https://github.com/zhuzhaoyun/Molio.git
cd Molio

# 安装依赖
pnpm install

# 启动开发环境 (daemon + web)
pnpm dev

# 或分别启动
pnpm dev:daemon   # 仅后端 :3100
pnpm dev:web      # 仅前端 :5173
```

### 构建桌面应用

```bash
# 一键构建 + 生成未打包版本
pnpm desktop:run

# 或完整打包为安装程序
pnpm package

# 仅生成未打包目录 (不生成安装包)
pnpm package:dir
```

### 测试与类型检查

```bash
pnpm test         # 运行所有测试 (node:test)
pnpm typecheck    # 全量类型检查
pnpm build        # 构建所有子包
```

## 用户交流群

<img src="docs/img/qrcode.png" alt="用户交流群二维码" width="200" />

## 致谢

Molio 的诞生离不开以下优秀开源项目的启发与支持：

- **[WeKnora](https://github.com/Tencent/WeKnora)** — 知识库管理平台，为 Molio 的知识库管理模块提供了设计参考
- **[multica](https://github.com/multica-ai/multica)** — 开源 Agent 管理平台，启发了 Molio 的多运行时编排与 Agent 交互设计
- **[doocs/md](https://github.com/doocs/md)** — 微信 Markdown 编辑器，Molio 的文档排版与多平台格式化能力基于其核心渲染引擎 `@md/core` 构建
- **[doocs/cose](https://github.com/doocs/cose)** — 全平台内容分发扩展，Molio 的多平台发布能力由其平台适配器层提供支持

感谢这些项目的作者和社区，让 Molio 能站在巨人的肩膀上快速成长。

## License

[Modified Apache 2.0](LICENSE) — 基于 Apache License 2.0，附加商业使用限制条款。内部使用和非商业场景完全免费，商业托管/嵌入需获取商业授权。
