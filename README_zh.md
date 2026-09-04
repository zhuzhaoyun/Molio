<div align="center">

# 📚 Molio (墨流)

**让 AI 拥有你的个人知识底座。数据全在本地，始终属于你。**

[English](README.md) · [中文](README_zh.md) · [🌐 官网](https://molio.cn/)

[![GitHub Release](https://img.shields.io/github/v/release/zhuzhaoyun/Molio?style=flat-square)](https://github.com/zhuzhaoyun/Molio/releases)
[![License](https://img.shields.io/github/license/zhuzhaoyun/Molio?style=flat-square)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/zhuzhaoyun/Molio?style=flat-square)](https://github.com/zhuzhaoyun/Molio/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/zhuzhaoyun/Molio?style=flat-square)](https://github.com/zhuzhaoyun/Molio/commits)

</div>

---

每个人都有自己的经验、方法和专业积累，但它们长期散落在笔记、文档和聊天记录中——AI 看不见它们，于是每一次对话，都从零开始。

Molio 把这些积累加工成 AI 可读、可调用的**个人知识底座**：Claude Code、Codex 等 Agent 进入你的知识空间，基于你的全部积累做研究、写作、问答、分析，产出以 Markdown 写回沉淀，底座越用越厚。所有内容存在你自己的电脑上，不经过任何第三方服务器。

还没有现成积累？[知识图谱资源库](https://molio.cn/resources.html)里有持续上新的**现成知识底座**，一键导入、开箱即用。

<div align="center">

[<img src="docs/img/video-poster.webp" alt="资治通鉴知识库演示" width="100%" style="border-radius: 8px;" />](https://molio.cn/videos/zizhitongjian-overview.mp4)

**▶ 点击播放演示** — 一本书，一个知识宇宙：《资治通鉴》1362 年史料 · 由 Molio 加工成 AI 可探索的知识底座

</div>

### 🔁 它如何工作

**01 · 收集与加工 — 从散落碎片，到可调用的知识底座**

Chrome 一键剪藏（[Web Clipper](https://chromewebstore.google.com/detail/pjdacbbkjpegfkogoieejajljplngbik)）、Obsidian 目录直接打开、本地文档批量导入——纯 Markdown，零迁移、无锁定，随时切回；Wiki 自动提取实体与概念、构建索引与摘要，知识图谱在它们之间建立关联。数据被加工，才开始成为底座。

**02 · Agent 工作 — 基于你的数据运行**

Claude Code、Codex、Gemini CLI、Qwen Code 等 Agent 在你的知识空间里做研究、写作、问答与分析——它们看到的不再是一张白纸，而是你的全部积累。统一图形界面选 Agent、看流式输出；微信扫码，手机上随时跟你的底座对话。

**03 · 沉淀回流 — 底座越用越厚**

每一次任务的产出都以 Markdown 写回知识空间，成为可复用的长期资产；知识图谱随之生长，下一次任务站得更高。想对外发布？doocs/md 排版 + doocs/cose 一键分发 30+ 平台，出口就在这里。

### 📦 知识图谱资源库

除了工具本身，Molio 还提供**现成的结构化知识图谱**——把一本书、一个专业领域预先整理成可直接导入 AI 的知识底座，开箱即用，不用从零搭建。

涵盖**文学、历史、哲学、中医、医学**等专业领域，**持续上新**。代表性资源如本体知识库、资治通鉴知识体系、妇产超声知识体系等，既有免费入门资源，也有深度整理的精品图谱——完整与最新清单见资源库页面。

> 这些是「人整理出来、AI 现搜不到现成结构」的独特内容。一键导入 Molio，立刻用 AI 做问答、关系查询、主题研究。

**[浏览全部资源 →](https://molio.cn/resources.html)**

### 📡 渠道支持

一个 Molio 实例可并行服务多个渠道，大多数渠道可在 Web 控制台一键接入。

| 渠道 | 文本 | 图片 | 文件 | 语音 | 群聊 |
|------|:----:|:----:|:----:|:----:|:----:|
| **Web 控制台** *(默认)* | ✅ | ✅ | ✅ | ✅ | — |
| **微信** | ✅ | ✅ | ✅ | ⏳ | ⏳ |
| **飞书** | ✅ | ✅ | ✅ | ⏳ | ✅ |
| Telegram | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Slack | ⏳ | ⏳ | ⏳ | — | ⏳ |
| Discord | ⏳ | ⏳ | ⏳ | — | ⏳ |

✅ 已支持 · ⏳ 计划中 · — 不适用

### 🖼️ 界面预览

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/img/main.png" alt="AI 对话" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>Agent 工作台：多 Agent 支持，流式响应</sub>
    </td>
    <td width="50%" align="center">
      <img src="apps/landing-page/images/wiki_knowledge.webp" alt="知识空间" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>知识空间：Vault 文件树管理与 Markdown 渲染</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="apps/landing-page/images/kg-graph.webp" alt="知识图谱" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>知识图谱：可视化浏览知识关联与结构</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/img/publish.png" alt="多平台发布" width="100%" style="border-radius: 8px;" />
      <br/>
      <sub>多平台发布：一键同步到 30+ 内容平台</sub>
    </td>
  </tr>
</table>

## 🚀 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/zhuzhaoyun/Molio/releases) 下载最新版本：

- **Windows**: `Molio-Setup-x.x.x.exe`
- **macOS**: `Molio-x.x.x.dmg`

安装后启动即可，首次使用会引导你配置 AI 运行时 CLI（如 Claude Code、Codex、Gemini 等）。

### 🐳 Docker / NAS 部署（自建服务）

把 Molio 作为自建 Web 服务跑在 NAS 或服务器上。单个容器内置 daemon、Web 界面和 Claude Code CLI，同时支持 `linux/amd64` 和 `linux/arm64` — 群晖、威联通、铁威马、TrueNAS、Unraid 等主流 NAS 均可使用。

> **⚠️ 与桌面端的区别（部署前请先了解）**
>
> - **只能用浏览器访问**，没有桌面客户端。Electron 桌面端只会连接它自己在本地启动的 daemon（`localhost`），**无法**连接到远程 NAS/服务器上的容器。
> - **daemon 跑在容器内，只能读写挂载进容器的目录**。桌面端那种"用文件夹选择器随便挑一个本地文件夹当知识库"的用法在这里不成立——浏览器里没有目录选择器，添加知识库时需要**手填容器内路径**（如 `/vaults/你的文件夹名`，不是 NAS 宿主机路径）。
> - 想让哪些文件夹成为知识库，就在 `docker-compose.yml` 的 `volumes` 里把它们挂载到 `/vaults` 下。你的数据仍然完全在自己手里（存在你的 NAS 上），只是访问方式从"桌面应用"变成了"浏览器 + 挂载目录"。

**一键安装**（需要 Docker + Docker Compose v2）：

```bash
# 国内（推荐）
curl -fsSL https://molio-releases.oss-cn-guangzhou.aliyuncs.com/script/install.sh | bash
# 海外
curl -fsSL https://raw.githubusercontent.com/zhuzhaoyun/Molio/main/install.sh | bash
# 离线（先克隆仓库，再运行内置脚本）
bash install.sh
```

脚本会交互式引导你填写知识库目录和端口，然后自动拉取镜像并启动服务。完成后浏览器打开 `http://<你的服务器IP>:3100`，再到「设置 → 运行时」配置 AI 模型和 API Key 即可。首次启动会**自动创建默认知识库**并指向挂载目录，打开即直接进入，无需手动配置。

**手动安装**（如果你更习惯直接用 `docker compose`）：

```bash
git clone https://github.com/zhuzhaoyun/Molio.git && cd Molio
cp .env.example .env      # AI 模型稍后在 Web 界面配置
docker compose up -d      # 然后打开 http://<你的服务器IP>:3100
```

**常用命令**（在安装目录下执行，默认 `~/molio`）：

```bash
docker compose logs -f                          # 查看日志
docker compose restart                          # 重启服务
docker compose pull && docker compose up -d     # 更新到最新版本
docker compose down                             # 停止服务
```

> 在 `.env` 中设置 `MOLIO_VAULT_PATH` 可把你已有的文档目录挂载进容器（挂载点为 `/vaults`）。全部配置项见 [`install.sh`](install.sh) 和 [`.env.example`](.env.example)。

### 从源码构建（开发者）

如果你想从源码构建或参与开发：

**前置要求：**
- **Node.js** >= 22
- **pnpm** >= 9
- 至少安装一个 AI 运行时 CLI：
  - [Claude Code](https://claude.ai/claude-code)
  - [OpenAI Codex CLI](https://github.com/openai/codex)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [Qwen Code](https://github.com/QwenLM/qwen-code)

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

**构建桌面应用：**

```bash
# 一键构建 + 生成未打包版本
pnpm desktop:run

# 或完整打包为安装程序
pnpm package

# 仅生成未打包目录 (不生成安装包)
pnpm package:dir
```

**测试：**

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

## 🏢 定制服务

把核心知识，留在你自己的院子里。散料炼成知识库，陪你用到会——数据处理、咨询、私有部署按需，一次演示见真章。

**[了解定制服务 →](https://molio.cn/enterprise.html)**

## 💬 用户交流群

扫码加入微信群，反馈问题、交流使用、参与讨论：

<img src="apps/landing-page/images/qrcode.png" alt="用户交流群二维码" width="200" />

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
