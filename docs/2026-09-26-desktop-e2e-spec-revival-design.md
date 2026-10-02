# 桌面端 E2E 修复：导航选择器换新、fixture 去机器绑定 —— 行为说明

> 对应：apps/desktop/e2e 下 smoke.spec.ts 与 protocol-clip-cold-start.spec.ts 的腐烂修复。本文描述**当前行为与设计取舍**，供维护和下次改动时查阅。

## 背景

桌面端 E2E 不在任何 CI 里，是纯本地工具（`pnpm package:dir` 出 win-unpacked 后，`cd apps/desktop && npx playwright test --config e2e/playwright.config.ts`）。UI 改版后没人同步它，两个 spec 全烂。本次修复后 6 条用例（smoke 5 + protocol 1）全绿。

## 四处腐烂与对策

### 1. 导航选择器：`data-tooltip` → `data-view`

smoke.spec.ts 的四个用例全挂在 `[data-tooltip="Home"/"Knowledge Base"/...]` 上。tooltip 是 i18n 文案——默认中文（首页/知识库/图谱/资源/历史记录 + 设置），且用户可在设置里切语言——**双重不稳定**，不能当选择器。

NavRail 每个入口都有 `data-view` 属性（home/knowledge/graph/resources/history/settings），与语言无关，web 层 E2E（`apps/web/e2e/helpers/navigation.ts` 的 `clickNav`）也用它。桌面 spec 全部换到 `data-view`，选择器优先级与仓库规范一致：`data-testid` > `data-view` > CSS class > 文本。

主导航循环同步为当前实际导航集：首页 → 知识库 → 资源 → 历史记录 → 设置 → 首页。Runtimes 已从主导航移除。

### 2. Runtimes 入口：设置页内的 tab

独立 `/runtimes` 路由已删，agent 管理界面现在是设置页里的 `RuntimesPanel`，经 `[data-testid="settings-tab-runtimes"]` tab 进入（与 `apps/web/e2e/runtimes-page.spec.ts` 口径一致，也支持 `/settings?tab=runtimes` 深链）。原断言（`.rt-shell` / `[role="tablist"]` / `.rt-agent-card` / `.rt-empty`）在 RuntimesPanel 里全部仍在，保留。

其余 class 断言（`.home-page`/`.home-landing`/`.chat-active`/`.composer`/`.kb-file-panel`/`.kb-vault-bar`/`.kb-empty-state`/`.kb-tree-item`/`.vm-overlay`/`.settings-shell`）逐一核对过当前代码，均有效，未动。

### 3. protocol spec 去机器绑定

protocol-clip-cold-start.spec.ts 原来写死了作者机器的 exe 路径、vault ID 和文件名。现在：

- **exe 路径**：读 `process.env.MOLIO_EXE_PATH`，由 global-setup.ts 统一解析（MOLIO_EXE_PATH 环境变量 → `apps/desktop/dist/win-unpacked/Molio.exe` → NSIS 安装目录），与 `launchMolioApp` 同一约定。
- **vault/file fixture**：新 helper `e2e/helpers/kb-fixture.ts` 在 beforeAll 里等 daemon 健康后运行时解析——`GET /api/knowledge/vaults` 取第一个 tree 能扫描成功的库（跳过路径已失效的库条目）→ 递归找任一 `.md`（跳过隐藏目录）→ 库里没有 .md 就 POST 造一个 `Clippings/e2e-protocol-cold-start.md` → 连可用库都没有就在系统临时目录建「E2E Fixture Vault」。fixture 创建后不删，重复运行是只读的。

### 4. 附带发现：`fullyParallel: false` 并不跨文件串行

修完上面三处后 protocol spec 仍挂在启动阶段（`electron.launch: target closed, exitCode=1`）。原因：配置注释写着 "Sequential: each test owns the full app lifecycle"，但 `fullyParallel: false` 只序列化**文件内**用例，两个 spec 文件仍会被多个 worker 并行拉起——两个 Molio 实例抢单实例锁和 3100 端口，后到者直接退出，Playwright 连不上页面。

对策：`playwright.config.ts` 补 `workers: 1`，跨文件也串行，这才符合配置注释本来的意图。

## 维护提示

- 跑之前确认本机 3100 端口空闲、没有正在运行的 Molio 实例（单实例锁会让被测 app 秒退；workers: 1 只保证 spec 之间不互踩，挡不住用户自己开着的 Molio）。
- 本机 RTK hook 会截断 playwright 输出，排查时看 `%LOCALAPPDATA%\rtk\tee\` 下的完整日志，或用 `rtk proxy` 绕过过滤。
- fixture 读写的是用户真实数据目录（`~/.molio`），但只在机器上一个可用库/文件都没有时才造 fixture，造了也能手动删。
