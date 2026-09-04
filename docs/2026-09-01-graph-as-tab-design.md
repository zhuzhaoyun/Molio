# 知识图谱 → KB 标签页 设计文档

> 创建：2026-09-01
> 分支：`feat/graph-as-tab`（worktree `/Users/albert/workspace/Molio-feat-graph-as-tab`）
> 依赖：基于含 #241（标签回收/recycle 模型）的最新 main。
> 背景：图谱页目前是独立的 `/graph` 路由（自包含 GraphPage，自管 Pixi 引擎）。本次把图谱做成**知识库标签工作区里的一个标签**，去掉独立页。

## 一、功能定位

图谱不再作为独立页面，而是 KB 标签工作区里一个**图谱标签**。点击左侧 NavRail「图谱」→ 进入知识库并**打开/激活**图谱标签。

- 图谱标签是 **vault 维度**（id `graph:<vaultId>`），每个 vault 至多一个（已存在则激活，不重复）。
- 图谱标签**不被点文件 recycle**（type 不是 file/blank，天然豁免）。
- 图谱标签可单独**关闭**（关掉后 NavRail 可再开）。
- **移除**独立 `/graph` 路由（不保留深链；如需兼容后续可加重定向）。

## 二、已确认决策

| 决策 | 选法 |
|---|---|
| 入口/形态 | 图谱**只作为标签**；去掉独立页；NavRail「图谱」→ 进 KB 并开/激活图谱标签 |
| 布局 | 图谱标签激活时**保留左侧文件树**（vault 切换器在此；图谱是 vault 维度）；图谱占右侧内容区 |
| 状态 | **keep-alive**：图谱标签切走再切回，状态（缩放/布局位置）保留 |
| 省资源 | GraphPage 加 `paused`/`active` prop：图谱 pane 隐藏时**暂停引擎 rAF**（保留数据/布局状态，不烧 CPU），切回恢复 |

## 三、架构 & 数据流

- **tab 类型**：新增 `'graph'`（`TabType` 已是 `'file' | string`，直接可用）。id `graph:<vaultId>`，type `'graph'`，title「图谱」，`vaultId` 标记所属库。
- **入口打开/激活图谱标签**：`openGraphTab(vaultId)` —— 若已有 `graph:<vaultId>` 标签 → `activateTab`；否则 `openTab`。NavRail 图谱点击走此逻辑（不在 `/knowledge` 先 `navigate('/knowledge?...')`）。
- **keep-alive 渲染（复用 publish 标签模式）**：KnowledgeBasePage 里
  - `graphTabOpen = tabs.tabs.some(t => t.id === graphTabId)`
  - `graphActive = tabs.activeTabId === graphTabId`
  - 图谱标签存在 → GraphPage **常驻挂载**在 `kb-main-panes` 的独立 pane；非激活时 CSS 隐藏 + `inert`；激活图谱时隐藏 KbMainContent 内容区（`kb-pane--closed`）。
  - GraphPage 收到 `active={graphActive}` → 隐藏时暂停引擎，激活时恢复。
- **图谱节点点击 → 打开文档**：复用现有 graph 节点→文档联动，激活/打开对应文件标签（图谱标签 keep-alive 保留）；前进/后退历史把图谱当「看过的标签」纳入（沿用 `navigationHistoryStore` 的思路，图谱标签也入栈——见远期备注）。

## 四、涉及文件

- `apps/web/src/App.tsx`：移除 `/graph` 路由 + GraphPage 引用。
- `apps/web/src/components/graph/GraphPage.tsx`：加 `active`/`paused` prop（暂停/恢复引擎 rAF）。
- `apps/web/src/components/kb/KnowledgeBasePage.tsx`：图谱标签开/激活逻辑 + keep-alive pane + 节点→文件联动。
- `apps/web/src/components/kb/KbTabBar.tsx`（视情况）：图谱标签在标签栏的呈现（标题/icon）。
- `apps/web/src/components/kb/kb-constants.ts`：`GRAPH_TAB_PREFIX` / `graphTabId(vaultId)`。
- `apps/web/src/hooks/useKbTabs.ts` 或 `KnowledgeBasePage`：`openGraphTab` 封装。
- `apps/web/src/components/NavRail.tsx`：图谱点击行为改（进 KB + 开图谱标签）。
- `apps/web/src/styles/knowledge.css` / `graph.css`：图谱 pane 布局。
- `apps/web/e2e/graph.spec.ts` 等：调整（不再独立页）+ 新增用例。

## 五、测试

- **单元**：`graphTabId` / 图谱标签开-激活逻辑（若抽成纯函数则 node:test）。
- **E2E**：
  - 点 NavRail「图谱」→ 进入 KB 并打开图谱标签（`data-testid` / 标签标题断言）。
  - 图谱标签 keep-alive：切到文件标签再切回，图谱状态保留（如缩放/节点仍在，等价于「不重新加载」）。
  - 图谱节点点击 → 打开对应文档文件标签。
  - 关闭图谱标签 → 消失；NavRail 可再开。
  - 相关既有 spec（`graph.spec.ts`、`publish-flow.spec.ts`、`bootstrap.spec.ts` / `navigation.spec.ts` 因 route/NavRail 变更需同步）。

## 六、待办 / 后续

- [ ] 实现（TDD）：先抽 `graphTabId` + 开/激活逻辑 → E2E 场景
- [ ] 未知：若保留 `/graph` 是否需要重定向兼容

## 七、图谱前进/后退按钮 · 悬浮方案（已确认）

> 依 `feat/navigation-history`（#244）的视图历史扩展，图谱做成标签后也应纳入前进/后退。图谱**没有标题栏**，按钮需安放在图谱内容区。已用可视化伴侣敲定（用户确认），等 #244/#245 合并后落地。

**放置（方案 C）**：图谱**顶栏（搜索框那一行）最左**——与文件标签页标题栏最左的前进/后退**位置完全一致**，切换文件/图谱标签时按钮不跳变。

**样式**：与 #244 完全一致——**裸 chevron（`‹ ›`）、无边框无底色**、hover 一次性轻水洗、disabled 置灰 `opacity:.45`、`aria-label`=后退/前进。因为落在白色顶栏上（非浮于画布），**无需毛玻璃衬底**（此前浮于画布的 A/B 方案才需要）。

**何时显示**：**常驻、置灰不可点**（与 #244 一致；在顶栏结构化区域，不打扰画布）。

**功能依赖**：需 `navigationHistoryStore`（#244）+ 图谱标签页（#245）。具体语义——图谱标签作为一个「被看过的视图」入栈；back/forward 经 `registerOpenFile` 重开目标（文件 or 图谱标签）。**合入后实现**。

**涉及文件（合入后）**：`GraphPage.tsx`（顶栏加按钮 + 接入 store）、`KnowledgeBasePage.tsx`（图谱标签入栈）、`navigationHistoryStore.ts`（图谱也算视图，或 store 扩展）。
