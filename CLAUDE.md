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
  contracts/    @molio/contracts  — shared types (AgentEvent, RunInfo, API types, SSE)
apps/
  daemon/       @molio/daemon    — Hono HTTP server, RunManager, SSE transport (→ CLAUDE.md)
    src/
      core/     RunManager, config, db (SQLite), transcript, runtimes/, streams/
      runtimes/ claude, codex, gemini, qwen — registry, launch, env
      streams/  claude-stream, codex-stream, json-event-stream, jsonl-parser
      routes/   agents, runs, events, tool-result, config, projects
      server.ts Hono app with CORS
      index.ts  Entry: @hono/node-server on port 3100
    test/       错误驱动测试用例 (node:test)
  web/          @molio/web       — Vite + React web UI consuming daemon SSE (→ CLAUDE.md)
    src/
      api/      client.ts, sse.ts
      hooks/    useAgents, useChat, useProjects
      components/ HomePage, NavRail, ChatPane, ChatComposer, UserMessage, AssistantMessage, ThinkingBlock, ToolCard
      styles/   tokens, base, rail, home, chat
    e2e/        E2E 测试场景
  desktop/      @molio/desktop   — Electron shell (deferred, placeholder only) (→ CLAUDE.md)
```

### Build & Dev Commands

```bash
pnpm dev          # daemon (tsx watch :3100) + web (vite :5173)
pnpm dev:daemon   # daemon only
pnpm dev:web      # web only
pnpm dev:desktop  # daemon + web + electron (需确保 5173/3100 端口未被占用)
pnpm build        # build all packages
pnpm test         # run daemon tests (node:test)
pnpm typecheck    # typecheck all packages
```

### Desktop 构建与运行

```bash
pnpm desktop:run    # 一键构建 + 生成未打包版本 (win-unpacked)，可直接运行 exe
pnpm package:dir    # 仅生成未打包目录 (不生成安装包)
```

生成的 `win-unpacked/` 目录包含可直接运行的 exe，无需安装。

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

**集成方式**: `@md/core` 是 workspace 私有包，未发布 npm。已将核心渲染代码 vendor 到 `apps/web/vendor/doocs-md/`，配合更新脚本实现便捷升级。

**当前状态**: ✅ 已集成。知识库文件查看页面使用 doocs/md 渲染，支持排版模式（左右分栏编辑器 + 实时预览 + 样式面板）。

**更新方法**:
```bash
cd apps/web
./scripts/update-doocs-md.sh main  # 拉取最新版本
pnpm install
```

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

## Runtime Context Loading

**核心机制**：KGE 的 agent CLI（Claude Code、Codex 等）通过 `cwd` 参数加载项目上下文。spawn 进程时设置 `cwd` 为项目的 `localPath`，agent CLI 会自动读取该目录下的 `CLAUDE.md`、`.claude/` 配置、以及所有 markdown 文件。

**实现方式**（`apps/daemon/src/core/RunManager.ts`）：
```typescript
const child = spawn(binary, args, {
  cwd: opts.cwd || agentConfig.env?.['KGE_CWD'] || process.cwd(),
});
```

**Web UI 传参**：创建 run 时，从当前 project 取出 `localPath` 作为 `cwd` 传给 daemon API（`POST /api/runs`）。

**不要做的事**：不要动态生成上下文文件到隔离目录。KGE 是本地知识库应用，用户的项目目录已经有完整的 `CLAUDE.md` 和文档结构，直接 `cd` 到那里就行。

## 用户偏好处理规则

**核心原则**：当用户已显式表达偏好（通过配置、双击设置等），系统必须尊重该选择，不得静默回退到其他选项。

**自动选择的正确逻辑**：
1. 如果用户已配置默认值（如 `defaultAgentId`）且该值可用，**始终使用用户的选择**
2. 如果用户已配置默认值但该值不可用（如 agent 已卸载），**保持未选择状态**并明确告知用户，不要静默切换到其他选项
3. 只在用户从未配置过默认值时（首次启动），才自动选择第一个可用选项，并**立即持久化**到配置中（视为一次性初始化，而非每次启动的 fallback）

**错误示例**：
```typescript
// ❌ 错误：当配置的默认值不可用时，静默选择其他 agent
if (defaultAgentId && isAvailable(defaultAgentId)) {
  setSelectedAgent(defaultAgentId);
} else {
  setSelectedAgent(firstAvailable);  // 无视了用户的选择
}
```

**正确示例**：
```typescript
// ✅ 正确：区分"用户已配置"和"用户从未配置"两种情况
if (defaultAgentId) {
  if (isAvailable(defaultAgentId)) {
    setSelectedAgent(defaultAgentId);  // 尊重用户选择
  }
  // 如果不可用，保持 null，让 UI 显示引导信息
  return;
}
// 只在从未配置时才自动选择并持久化
const first = findFirstAvailable();
if (first) {
  setSelectedAgent(first.id);
  persistDefault(first.id);  // 下次启动走上面的分支
}
```

**适用范围**：任何涉及用户偏好设置的功能（默认运行时、默认项目、主题选择等）。





