# 知识库标签工作区「前进/后退」导航历史 — 设计文档

> 创建：2026-08-31
> 修订：2026-09-01（v2 — 从「全局 page+file 历史」收敛为「标签内视图历史」，并适配 PR #241 的标签回收模型）
> 分支：`feat/navigation-history`（worktree `/Users/albert/workspace/Molio-feat-navigation-history`）
> 当前状态：**v2 已实现并验证**（基于含 #241 的 main）。提交 `a39d929a`（rebase 到 #241）+ `e2dcf52c`（v2 适配）已推送。
> 背景：旧分支 `fix/page-transition-interactions`（2026-07-15，未合入）遗留了 back/forward 实现，当时对布局/表现不满意。本次重做：复用旧分支的 history-store 思路、重做表现层（Obsidian 式低调按钮）、并收敛作用域到标签工作区。

## 一、功能定位

在**知识库标签工作区内部**提供前进/后退，实现标签内的**功能闭环**。**不再是全局页面历史**——页面（首页/图谱/历史/设置）之间用左侧 `NavRail` 切换，不做跨页 back/forward。

- **记录**：用户**看过的文件的先后顺序**（按 filePath）。
- **back / forward**：在这个顺序里走——后退重开上一个文件、前进重开下一个。
- **为什么**：Obsidian 的 back/forward 本质是「看过的文档历史」，不是页面堆栈。未来知识图谱做成标签页后，就是一个「图谱标签」，自然并入同一套标签历史。

## 二、表现层

- **位置**：固定在知识库文档标题栏（`kb-main-header`）**最左侧**。标题栏对所有状态都渲染（含空态），故固定位置可用。
- **样式**：**无边框、无底色、无 tooltip** 的裸 chevron（`‹ ›`），hover 一次性轻水洗，disabled 置灰 `opacity:.45`。`aria-label`=后退/前进（去 tooltip 不丢无障碍）。
  - 与标签栏滚动箭头 `‹ ›` 区分：按钮更大字号、`--text` 深色、位置在标题栏；标签滚动箭头是灰色细 chevron、只在标签栏。
- **frontmatter 属性**：折叠态徽标 + `▴▾` 收成一枚**属性 pill**（复用 i18n `kb.frontmatter.properties`），与左侧 nav 组用空位+形态区分。仅 wiki 文档（有 frontmatter）时出现。

## 三、交互规则

- **入栈**：订阅 `activeTabId` 变化，文件标签变成活跃时入栈（`file:<path>` → filePath）。点文件、点标签、back/forward 重激活都会触发；重激活靠**去重**（back/forward 已把位置移到目标，re-push 命中当前 → 去重，不重复入栈）。
- **back/forward 触发**：经 `registerOpenFile(filePath)` 调 **`handleSelectFile`** 重新打开目标文件：
  - 已是打开的标签 → 激活它；
  - 否则走 #241 逻辑 recycle 当前可回收标签（file/blank、未固定）；
  - 当前标签固定/特殊 → 才开新标签。
  - 结果：**导航不新增标签**、未保存编辑的丢弃确认仍生效。
- **空态**：按钮始终显示，无历史/无方向时置灰不可点。
- **闭环**：历史总是「能重开回来的文件序列」，back/forward 在其中来回，永不脱靶。

## 四、与 PR #241（标签回收模型）的适配

#241（`feat/kb-tabs-interaction`）把「点文件→开新标签」改为「载入当前未固定标签（recycle）」，标签 `id` 从 `file:<旧>` 覆写成 `file:<新>`；pinned 标签/publish 特殊标签豁免、另开新签。**v1 在此会失效**：

- `prune`（历史=打开中标签）会让历史坍缩成单个当前文件（标签 id 每次被覆写）。
- 按 `file:<path>` 的 `activateTab` 找不到已被覆写掉的旧标签。

**v2 适配（已落地）**：key 在「看过的文件序列」而非「打开中的标签」——**去掉 `prune`**；back/forward 用 `handleSelectFile` **重开目标文件**（见第三节）。store 移除 `prune`，单测 13→11，E2E 改为「文件序列重开不增标签」。

## 五、涉及文件

- `apps/web/src/stores/navigationHistoryStore.ts` — 文件视图历史栈（去 prune）
- `apps/web/src/components/kb/KnowledgeBasePage.tsx` — `activeTabId` 入栈 + `registerOpenFile`→`handleSelectFile`
- `apps/web/src/components/kb/KbMainContent.tsx` — 标题栏裸 chevron 按钮 + 属性 pill
- `apps/web/src/i18n/locales/{zh,en}.ts` — `nav.back` / `nav.forward`
- `apps/web/src/styles/knowledge.css` — nav 裸 chevron / 属性 pill
- `apps/web/e2e/navigation-history.spec.ts`（`@area navigation / @priority P1`）
- `apps/web/test/navigation-history/navigationHistoryStore.test.ts`（11 例）

## 六、验证

- typecheck ✅（需先 `pnpm --filter @molio/contracts build`）
- 全量单测 ✅ 80/80
- E2E：`navigation-history` 3/3（渲染、初始禁用、文件序列 back/forward 不增标签）＋ `kb-tabs` 4 + `publish-flow` 2 全绿

## 七、待办 / 后续

- [ ] 开 PR（base main）
- [ ] 未来：知识图谱做成标签页后并入同一套标签历史（new tab type 'graph' + 渲染）；届时 back/forward 自动纳入图谱标签
