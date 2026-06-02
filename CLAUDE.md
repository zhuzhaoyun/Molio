# CLAUDE.md


想要实现的目标如下，知识管理，文档创建，排版，多平台发布
1、可以管理客户本地的知识库，类似 obsidian + llm_wiki, 也可以使用 weknora 管理知识库
2、调用 claude code runtime 或 codex 创作或编写文档
3、使用 doocs/md 排版，以及 doocs/cose 进行多平台发布 

实际上每个的核心组件都有了相关的开源项目，我现在就套壳，做个本地应用，将这些项目或者组件串联起来，组成一个产品



## Project Structure (pnpm Monorepo)

> 各子包详细说明见各自 `CLAUDE.md` 文件。

```
packages/
  contracts/    @kge/contracts  — shared types (AgentEvent, RunInfo, API types, SSE)
apps/
  daemon/       @kge/daemon    — Hono HTTP server, RunManager, SSE transport (→ CLAUDE.md)
    src/
      core/     RunManager, config, db (SQLite), transcript, runtimes/, streams/
      runtimes/ claude, codex, gemini, qwen — registry, launch, env
      streams/  claude-stream, codex-stream, json-event-stream, jsonl-parser
      routes/   agents, runs, events, tool-result, config, projects
      server.ts Hono app with CORS
      index.ts  Entry: @hono/node-server on port 3100
    test/       错误驱动测试用例 (node:test)
  web/          @kge/web       — Vite + React web UI consuming daemon SSE (→ CLAUDE.md)
    src/
      api/      client.ts, sse.ts
      hooks/    useAgents, useChat, useProjects
      components/ HomePage, NavRail, ChatPane, ChatComposer, UserMessage, AssistantMessage, ThinkingBlock, ToolCard
      styles/   tokens, base, rail, home, chat
    e2e/        E2E 测试场景
  desktop/      @kge/desktop   — Electron shell (deferred, placeholder only) (→ CLAUDE.md)
```

### Build & Dev Commands

```bash
pnpm dev          # daemon (tsx watch :3100) + web (vite :5173)
pnpm dev:daemon   # daemon only
pnpm dev:web      # web only
pnpm build        # build all packages
pnpm test         # run daemon tests (node:test)
pnpm typecheck    # typecheck all packages
```

## 错误驱动测试 (Error-Driven Testing)

**强制规则**：每次遇到报错（构建错误、运行时错误、逻辑错误），在修复 bug 之前或同时，必须：

1. **在 `apps/daemon/test/` 目录下添加一条测试用例**，复现该错误的场景
2. **测试命名**：描述错误场景，如 `claude-stream-dedup.test.ts`
3. **测试结构**：用 Node.js 内置 `node:test`，不引入额外依赖
4. **运行验证**：`pnpm test` 确认新测试通过
5. **不要只修 bug 不加测试** —— 每个 bug 都是一条永久测试用例

典型流程：
```
遇到报错 → 写测试复现 → 确认测试失败 → 修复 → 确认测试通过 → 提交
```

### E2E 测试策略

**核心原则**：WebUI first，Electron 只是壳。E2E 直接测 web 层。

- 使用 kimi-webbridge 或 Playwright 对 `http://localhost:5173` 进行浏览器自动化测试
- 测试 UI 交互行为（选择 agent → 发送消息 → 查看 SSE 事件流 → 提交 tool result）
- Electron 壳后期只需测试窗口管理和系统集成

## External Dependencies (Planned Integration)

### doocs/md — Markdown 排版引擎

**仓库**: https://github.com/doocs/md  
**用途**: 文档排版与编辑，提供 Markdown → 多平台格式化 HTML 的渲染能力。

**技术栈**: Vue 3 + Vite + TypeScript monorepo。核心渲染引擎 `@md/core` 是框架无关的。

**关键能力**:
- `marked` v18 + 12 个自定义扩展（KaTeX 数学公式、Mermaid 图表、PlantUML、脚注、目录等）
- `highlight.js` 代码高亮（懒加载语言包）
- CSS 变量主题系统：3 套内置主题（经典/优雅/简洁）+ 自定义 CSS 支持
- CSS 处理器：运行时解析 `var(--xxx)` 和 `calc()` 表达式，输出自包含 HTML（微信公众号兼容）
- `juice` CSS 内联：将样式内联到 HTML 元素，确保微信编辑器粘贴兼容
- 剪贴板双格式写入：`text/html` + `text/plain` 同时写入

**集成方式**: `@md/core` 是 workspace 私有包，未发布 npm。需要 vendor 核心渲染代码（`marked` + 扩展 + 主题系统 + CSS 处理），或基于 `marked` + `highlight.js` 自建并参考其主题架构。

**当前状态**: 项目使用手写正则 Markdown 渲染器（`renderMarkdown()` 函数），待替换为 doocs/md 渲染引擎。

### doocs/cose — 全平台分发

**仓库**: https://github.com/doocs/cose  
**用途**: 将文章一键发布到 30+ 内容平台。

**类型**: Chrome 扩展（Manifest V3），**不是** npm 包或 SDK。

**支持平台 (33个)**:
- 自媒体：微信公众号、今日头条、知乎、抖音、小红书、百家号、网易号、搜狐号、微博、B站、豆瓣、少数派、Twitter/X
- 博客/技术社区：CSDN、博客园、掘金、Medium、思否、InfoQ、简书、开源中国、51CTO
- 云平台：腾讯云、阿里云、华为云、百度千帆、支付宝开放平台、ModelScope、火山引擎

**架构**: 
- `@cose/core` — 平台适配器层，每个平台一个 adapter 文件
- `@cose/detection` — 登录状态检测（通过 offscreen document + cookie-aware fetch）
- 两种内容注入策略：Markdown 直注（Markdown 编辑器平台）和 HTML 剪贴板模拟（富文本编辑器平台如微信）

**集成方式**: 作为 Chrome 扩展配合使用，不能作为库导入。如需自定义集成，可 fork 平台适配器的 DOM 操作逻辑，结合 Puppeteer/Playwright 实现无浏览器自动化。