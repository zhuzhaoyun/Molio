<div align="center">

# 📚 Molio (墨流)

**你的本地知识库 + AI 写作台 + 全平台发布器 — 数据全在你自己的电脑上**

[English](README.md) · [中文](README_zh.md)

[![GitHub Release](https://img.shields.io/github/v/release/zhuzhaoyun/Molio?style=flat-square)](https://github.com/zhuzhaoyun/Molio/releases)
[![License](https://img.shields.io/github/license/zhuzhaoyun/Molio?style=flat-square)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/zhuzhaoyun/Molio?style=flat-square)](https://github.com/zhuzhaoyun/Molio/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/zhuzhaoyun/Molio?style=flat-square)](https://github.com/zhuzhaoyun/Molio/commits)

</div>

---

Molio 是一款**本地优先**的桌面应用，将知识管理、AI 写作和内容发布串联为一体。直接打开你的 Obsidian 知识库，在图形界面里调用 Claude Code / Codex / Gemini 写文档，通过微信在手机上和知识库对话，写完一键排版发布到公众号、知乎、头条等 30+ 平台 — 所有内容存在你自己的电脑上，不经过任何第三方服务器。

### 🌟 核心能力

| 功能 | 说明 |
|------|------|
| 🗂️ **Obsidian 兼容** | 直接打开你的 Obsidian 目录，零迁移；纯 Markdown 文件，无厂商锁定，随时切回 |
| 🤖 **多 Agent 图形界面** | 在统一界面里使用 Claude Code、OpenAI Codex、Gemini CLI、Qwen Code，支持流式输出 |
| 🔒 **本地优先** | 知识库、AI 对话、所有设置全在本地 — 完全私密，不经过任何第三方服务器 |
| ✂️ **[Web Clipper](https://github.com/zhuzhaoyun/molio-connect)** | Chrome 扩展一键剪藏网页到知识库，自动唤起桌面端定位到刚保存的文件 |
| 📝 **智能编辑器** | 左右分栏 Markdown 编辑器，实时预览，语法高亮，AI 辅助写作 |
| 🎨 **专业排版** | 基于 [doocs/md](https://github.com/doocs/md) 的排版引擎，公众号/知乎/头条格式一键转换 |
| 🚀 **30+ 平台发布** | 写完即发，告别逐平台复制粘贴 — 基于 [doocs/cose](https://github.com/doocs/cose)，深度适配国内内容平台 |
| 💬 **微信 AI 助手** | 扫码连接个人微信，手机上和你的知识库对话；发公众号链接自动总结并存入知识库 |
| 📖 **知识图谱** | 可视化浏览知识关联与结构 |

### 🖼️ 界面预览

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/img/main.png" alt="AI 对话" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>AI 对话：多 Agent 支持，流式响应</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/img/wiki_knowledge.png" alt="知识库" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>知识库：Vault 文件树管理与 Markdown 渲染</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/img/Layout%20.png" alt="排版编辑器" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>排版编辑器：左右分栏实时预览，主题/字体/颜色可调</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/img/publish.png" alt="多平台发布" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>多平台发布：一键同步到 30+ 内容平台</sub>
    </td>
  </tr>
</table>

## 🚀 快速开始

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

## 🛠️ 开发与测试

```bash
pnpm test         # 运行所有测试 (node:test)
pnpm typecheck    # 全量类型检查
pnpm build        # 构建所有子包
pnpm test:e2e     # E2E 测试 (需先启动 pnpm dev)
```

## 🏗️ 项目架构

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

**技术栈：**
- **前端：** React 19 + Vite 6 + TypeScript
- **后端：** Hono + Node.js + SQLite (better-sqlite3)
- **桌面：** Electron 40 + electron-builder
- **构建：** pnpm workspace monorepo

## ❓ 常见问题

### macOS 提示"已损坏，无法打开"

这是 macOS Gatekeeper 的安全提示，因为 Molio 目前**未经过 Apple 公证**（需要 Apple Developer Program 年费 $99）。这不是应用本身的问题，请按以下任一方法解决：

**方法一（推荐）**：右键点击应用 → 选择"打开" → 点击"打开"按钮（只需第一次）

**方法二**：打开终端，运行：
```bash
sudo xattr -d com.apple.quarantine /Applications/Molio.app
```

之后即可正常双击打开。

## 💬 用户交流群

扫码加入微信群，反馈问题、交流使用、参与讨论：

<img src="docs/img/qrcode.png" alt="用户交流群二维码" width="200" />

## ❤️ 致谢

Molio 的诞生离不开以下优秀开源项目的启发与支持：

- **[multica](https://github.com/multica-ai/multica)** — 开源 Agent 管理平台，启发了 Molio 的多运行时编排与 Agent 交互设计
- **[doocs/md](https://github.com/doocs/md)** — 微信 Markdown 编辑器，Molio 的文档排版与多平台格式化能力基于其核心渲染引擎 `@md/core` 构建
- **[doocs/cose](https://github.com/doocs/cose)** — 全平台内容分发扩展，Molio 的多平台发布能力由其平台适配器层提供支持
- **[WeKnora](https://github.com/Tencent/WeKnora)** — 腾讯开源知识库管理平台，为 Molio 的知识库模块提供了设计理念参考

感谢这些项目的作者和社区，让 Molio 能站在巨人的肩膀上快速成长。

## 📄 License

[Modified Apache 2.0](LICENSE) — 基于 Apache License 2.0，附加商业使用限制条款。内部使用和非商业场景完全免费，商业托管/嵌入需获取商业授权。

---

<div align="center">

**如果 Molio 对你有帮助，欢迎给个 ⭐️ [Star](https://github.com/zhuzhaoyun/Molio) 支持一下！**

[⭐ Star](https://github.com/zhuzhaoyun/Molio) · [🐛 反馈问题](https://github.com/zhuzhaoyun/Molio/issues) · [💡 功能建议](https://github.com/zhuzhaoyun/Molio/issues)

</div>
