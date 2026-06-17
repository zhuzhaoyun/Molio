# Molio — 本地知识管理 + AI 写作 + 多平台发布

知识管理、文档创建、排版、多平台发布的一站式本地应用：
1. 管理本地知识库（类 Obsidian + LLM Wiki），支持 weknora 知识库
2. 调用 Claude Code / Codex 等 AI runtime 创作或编写文档
3. 使用 doocs/md 排版，doocs/cose 进行多平台发布

## Project Structure (pnpm Monorepo)

> 各子包详细说明见各自 `CLAUDE.md` 文件。

```
packages/
  contracts/    @molio/contracts  — shared types (AgentEvent, RunInfo, API types, SSE)
apps/
  daemon/       @molio/daemon    — Hono HTTP server, RunManager, SSE transport (→ apps/daemon/CLAUDE.md)
  web/          @molio/web       — Vite + React web UI, consuming daemon SSE (→ apps/web/CLAUDE.md)
  desktop/      @molio/desktop   — Electron shell (→ apps/desktop/CLAUDE.md)
```

## Build & Dev Commands

```bash
pnpm dev          # daemon (tsx watch :3100) + web (vite :5173)
pnpm dev:daemon   # daemon only
pnpm dev:web      # web only
pnpm dev:desktop  # daemon + web + electron (需确保 5173/3100 端口未被占用)
pnpm build        # build all packages
pnpm test         # run daemon + desktop tests (node:test)
pnpm test:e2e     # run web E2E tests (Playwright, 需先 pnpm dev)
pnpm typecheck    # typecheck all packages
```

### Desktop 构建与运行

```bash
pnpm desktop:run    # 一键构建 + 生成未打包版本 (win-unpacked)，可直接运行 exe
pnpm package:dir    # 仅生成未打包目录 (不生成安装包)
pnpm package        # 完整打包
```

生成的 `win-unpacked/` 目录包含可直接运行的 exe，无需安装。

## Chrome 扩展同步打开协议

Molio Chrome 扩展保存剪藏时通过 `molio://` 唤起桌面端。协议约定：

- `molio://open/vault/<vaultId>/file/<filePath>`：已知 vault 时直接打开指定文件
- `molio://open/file/<filePath>`：只知道文件相对路径时，由 Web 端使用当前/默认 vault 解析
- `molio://launch`：只用于打开应用，不应作为剪藏保存后的文件定位主路径

桌面端只负责解析协议并导航到 `/knowledge?...`；Web 端负责等待目标 vault 的文件树加载完成，再选中文件。扩展可能先发出文件打开意图再完成写入，因此 Web 端文件读取允许一次短重试。改这条链路时要同时检查 `molio-connect/background.js`、`apps/desktop/src/main.js`、`apps/web/src/components/kb/KnowledgeBasePage.tsx` 和 `apps/web/src/hooks/useKnowledge.ts`。

## Runtime Context Loading

Agent CLI（Claude Code、Codex 等）通过 `cwd` 参数加载项目上下文。spawn 进程时设置 `cwd` 为项目的 `localPath`，agent CLI 会自动读取该目录下的 `CLAUDE.md`、`.claude/` 配置、以及所有 markdown 文件。

**实现方式**（`apps/daemon/src/core/RunManager.ts`）：
```typescript
const child = spawn(binary, args, {
  cwd: opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd(),
});
```

**Web UI 传参**：创建 run 时，从当前 project 取出 `localPath` 作为 `cwd` 传给 daemon API（`POST /api/runs`）。

**不要做的事**：不要动态生成上下文文件到隔离目录。用户的项目目录已经有完整的 `CLAUDE.md` 和文档结构，直接 `cd` 到那里就行。

## 错误驱动测试 (Error-Driven Testing)

**强制规则**：每次遇到报错，修复 bug 的同时必须在对应包的 `test/` 目录下添加测试用例：

| 错误来源 | 测试位置 | 测试框架 |
|---------|---------|---------|
| daemon bug | `apps/daemon/test/<module>/xxx.test.ts` | node:test |
| desktop bug | `apps/desktop/test/<module>/xxx.test.js` | node:test |
| web bug | `apps/web/e2e/xxx.spec.ts` | Playwright |

典型流程：`遇到报错 → 写测试复现 → 确认测试失败 → 修复 → 确认测试通过 → 提交`

### E2E 测试 (Web)

**核心原则**：WebUI first，Electron 只是壳。E2E 直接测 web 层。

- 使用 Playwright 对 `http://localhost:5173` 进行测试
- 前置条件：`pnpm dev`（daemon + web 同时运行）
- 常用命令：`npx playwright test` / `--ui` / `--debug` / `--headed` / `-g "test name"`
- 定位策略：优先 `data-testid`，其次 CSS class，不依赖文本内容
- 编写规范见 `apps/web/CLAUDE.md`

### UI 改动与 E2E 同步（强制规则）

界面调整必须同步修改对应测试，同一个 commit 提交。`data-testid` 比 CSS class 更稳定，关键交互元素应使用：

```tsx
<button data-testid="create-vault-btn" className={styles.submit}>创建</button>
// 测试：page.locator('[data-testid="create-vault-btn"]')
```

### E2E 核心流程保护

触及以下文件的 PR 必须运行全量 E2E 并确认全绿：

```
apps/web/src/components/HomePage.tsx, ChatComposer.tsx, UserMessage.tsx,
  AssistantMessage.tsx, ThinkingBlock.tsx, ToolCard.tsx, NavRail.tsx
apps/web/src/hooks/useChat.ts, useChatCore.ts
apps/web/src/api/client.ts, sse.ts
apps/web/src/App.tsx
apps/daemon/src/routes/runs.ts, events.ts
apps/daemon/src/core/RunManager.ts
```

快速检查：`cd apps/web && npx playwright test`

## 用户偏好处理规则

当用户已显式表达偏好（通过配置、双击设置等），系统必须尊重该选择，不得静默回退到其他选项。

**自动选择的正确逻辑**：
1. 如果用户已配置默认值且该值可用，**始终使用用户的选择**
2. 如果用户已配置默认值但该值不可用，**保持未选择状态**并明确告知用户，不要静默切换到其他选项
3. 只在用户从未配置过默认值时（首次启动），才自动选择第一个可用选项，并**立即持久化**到配置中

## 团队贡献规则

**核心原则**：所有代码变更必须通过 Pull Request 流程，**禁止直接 push 到 main 分支**。

### 工作流程

```bash
git checkout main && git pull origin main
git checkout -b feat/功能名称   # 或 fix/、refactor/、chore/、docs/
git add . && git commit -m "feat(scope): 描述"
git push -u origin feat/功能名称
gh pr create --title "feat: 功能描述" --base main
```

### 分支命名

| 类型 | 格式 | 示例 |
|------|------|------|
| 新功能 | `feat/功能简述` | `feat/auto-update-check` |
| Bug 修复 | `fix/问题描述` | `fix/daemon-port-conflict` |
| 重构 | `refactor/模块名` | `refactor/knowledge-base-ui` |
| 配置/工具 | `chore/任务` | `chore/upgrade-dependencies` |
| 文档 | `docs/内容` | `docs/api-guide` |

### Commit Message

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`<type>(<scope>): <description>`

Scope: `daemon` | `web` | `desktop` | `kb` | `ci`

### PR 合并规则

1. 必须创建 PR，不能直接 push main
2. 至少 1 个 approve（紧急情况除外）
3. 与 main 冲突时必须 rebase 解决
4. CI 全部通过
5. E2E 门禁：触及核心流程组件的 PR 必须 E2E 全绿
6. 多 commit 的 PR 建议 squash 合并

**管理员权限**仅在紧急 hotfix、修复 CI 配置、协作者不可用等情况下使用，正常开发仍走 PR + Review 流程。