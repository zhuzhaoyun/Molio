# Molio (墨流)

> AI 驱动的本地知识管理与文档创作平台

Molio 是一个本地优先的桌面应用，将知识库管理、AI 辅助写作和多平台发布串联为一体。通过编排本地 AI 运行时（Claude Code、OpenAI Codex、Gemini CLI、Qwen Code），在你的设备上完成文档创作，无需将数据上传到云端。

## 核心功能

- **知识库管理** — 类似 Obsidian 的本地 Vault 管理，支持文件树浏览、创建、编辑、删除
- **AI 辅助写作** — 通过本地 AI 运行时进行文档创作，支持多轮对话、工具调用、流式输出
- **多运行时编排** — 支持 Claude Code / OpenAI Codex / Gemini CLI / Qwen Code，一键切换
- **项目上下文加载** — AI 进程自动加载项目目录下的 `CLAUDE.md` 和文档结构
- **桌面应用** — Electron 打包为 Windows 原生应用，开箱即用

### 计划集成

- **[doocs/md](https://github.com/doocs/md)** — Markdown 排版引擎，支持微信公众号等平台格式化
- **[doocs/cose](https://github.com/doocs/cose)** — 全平台分发，一键发布到 30+ 内容平台

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Vite 6 + TypeScript |
| 后端 | Hono + Node.js + SQLite (better-sqlite3) |
| 桌面 | Electron 33 + electron-builder |
| 构建 | pnpm workspace monorepo |
| 测试 | node:test (内置) |

## 项目结构

```
Molio/
├── packages/
│   └── contracts/       @kge/contracts — 共享类型定义
├── apps/
│   ├── daemon/          @kge/daemon   — Hono HTTP 服务端 (API + SSE)
│   ├── web/             @kge/web      — Vite + React 前端
│   └── desktop/         @kge/desktop  — Electron 桌面壳
└── package.json         monorepo 根配置
```

### Daemon (后端服务)

Hono HTTP 服务器，运行在 `localhost:3100`，负责：
- AI 运行时进程管理（spawn / cancel / tool-result 提交）
- SSE 事件流推送（实时流式输出）
- 知识库 Vault CRUD + 文件操作
- 项目管理和配置存储

### Web (前端界面)

Vite + React SPA，运行在 `localhost:5173`，提供：
- **首页** — AI 对话界面，支持选择 Agent、发送消息、查看流式响应
- **知识库** — Vault 文件树管理、文件编辑、操作历史
- **运行时** — AI 运行时状态查看与配置

### Desktop (桌面应用)

Electron 壳，内嵌 daemon + web，打包为 Windows 原生应用。

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
git clone https://github.com/your-username/Molio.git
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
pnpm test         # 运行 daemon 测试 (node:test)
pnpm typecheck    # 全量类型检查
pnpm build        # 构建所有子包
```

## API 概览

Daemon 提供 REST API + SSE 事件流：

| Method | Endpoint | 说明 |
|--------|----------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/agents` | 列出可用 AI 运行时 |
| POST | `/api/runs` | 创建新的 AI 运行 |
| GET | `/api/runs/:id/events` | SSE 事件流（流式输出） |
| POST | `/api/runs/:id/tool-result` | 提交工具调用结果 |
| GET/POST/DELETE | `/api/knowledge/vaults` | 知识库 Vault 管理 |
| GET/POST/DELETE | `/api/knowledge/vaults/:id/files/*` | 文件读写删 |
| GET | `/api/knowledge/vaults/:id/tree` | 文件树扫描 |
| GET/PUT | `/api/config` | 应用配置 |
| CRUD | `/api/projects` | 项目管理 |

## 开发规范

- **错误驱动测试**：每个 bug 修复必须同时添加复现测试用例到 `apps/daemon/test/`
- **Git 分支**：同一 issue 的后续修复优先在已有分支上追加 commit
- **WebUI First**：E2E 测试直接测 web 层，Electron 壳只测窗口管理
- **用户偏好**：当用户已显式配置默认值时，系统不得静默回退到其他选项

## License

MIT
