# @molio/web — Web UI

Vite + React 前端，消费 daemon SSE 事件流，提供聊天式 AI 交互界面。

## 技术栈

- **Framework**: React 19 + TypeScript
- **Build**: Vite 6
- **样式**: 纯 CSS (CSS Variables + 组件级 CSS 文件)

**CSS 约定（强制）**：
- `<select>` 元素设置背景色时**必须**使用 `background-color` 而非 `background` 简写。
  `base.css` 全局给 `<select>` 定义了自定义下拉箭头（`background-image` / `background-repeat` / `background-position` / `background-size` 四个长写属性），`background` 简写会将它们全部复位为默认值，导致箭头丢失或出现多个箭头。
  同理，任何想保留全局 base 样式的元素，覆盖背景色时一律用长写属性。
- **状态管理**: React hooks (useState/useRef/useCallback)

## 目录结构

```
src/
  main.tsx             React 入口
  App.tsx              根组件：视图路由 (home / knowledge / history / settings / graph)
  App.css              全局布局样式
  api/
    client.ts          HTTP 客户端 (fetch wrapper)
    sse.ts             SSE 订阅 (EventSource)
  hooks/
    useAgents.ts       获取可用 agent 列表
    useChatCore.ts     聊天核心逻辑（ChatMessage / ToolEvent 类型的唯一来源）
    useProjects.ts     项目管理
    useKnowledge.ts    知识库状态管理（vault、文件树、排版模式）
    useKbTabs.ts       知识库 Tab 状态管理
    useRuntimes.ts     运行时管理
    useWikiChat.ts     Wiki 对话状态管理
    useChannelStatus.ts 渠道状态轮询 + busy/error/runAction（feishu/weixin 共用）
    useResourcePay.ts  资源购买支付状态机（直连 pay.molio.cn：下单/轮询/交付）
  data/
    resources.ts       资源数据桥 —— import 官网 apps/landing-page/resources-data.js（单一数据源）
  stores/
    vaultStore.ts          活跃知识库选择（useSyncExternalStore，App + useKnowledge 共享）
    messageSelectionStore.ts  消息删除勾选态（同模式 + 每气泡精准订阅）
    authStore.ts           登录态快照（同模式；镜像 daemon GET /api/auth/status，App 挂载拉取 + 30s 轮询 + focus 刷新；refresh 永不抛错）
  components/
    HomePage.tsx       主页（`/chat`）：landing + 活动会话全屏态
    NavRail.tsx        左侧导航栏
    ChatSessionView.tsx 会话消息列表纯视图（`/chat` 与悬浮面板共用；消息级动作在此）
    ChatComposer.tsx   消息输入框
    UserMessage.tsx    用户消息气泡
    AssistantMessage.tsx 助手消息气泡 (thinking + tool cards)
    ThinkingBlock.tsx  思考过程折叠块
    ToolCard.tsx       工具调用卡片
    ToolGroup.tsx      工具调用分组
    SourceChips.tsx    助手回复底部的引用来源条（平铺 / 台账两形态）
    MessageToolbar.tsx 消息操作条（复制/重生成/继续/编辑/删除，hover 显隐）
    OverflowMenu.tsx   ⋯ 溢出菜单（收纳低频动作）
    CodeBlock.tsx      代码块（语言标签 + 复制 + 长代码折叠）
    SaveToKbButton.tsx 一键保存助手回复到当前知识库
    QuizCard.tsx       题卡（作答/判分 +「存为题库」手动存档出口）
    SelectionConfirmBar.tsx 删除勾选态顶部确认条
    MessageCheckbox.tsx  勾选态下每气泡的方框
    icons.tsx          聊天交互 SVG 线条图标
    UpdateNotification.tsx 更新通知
    graph/             知识图谱组件
      GraphPage.tsx    图谱主页面（数据获取 / 筛选 / 引擎生命周期 / 回调路由）
      GraphSearchBox.tsx 顶栏节点搜索定位（模糊匹配 + 键盘导航 + focusNode）
      GraphSettingsPanel.tsx 设置面板（筛选/外观/力度/图例 4 tab）
      Minimap.tsx      右下角小地图（事件驱动重绘 + 点击/拖拽视口导航）
      types.ts         设置/主题/力参数类型 + NODE_TYPE_COLORS/LABELS 单一来源
      useGraphSettings.ts 设置持久化（localStorage）+ 版本迁移
      engine/
        pixiGraphEngine.ts PixiJS WebGL 渲染 + d3-force 仿真引擎（移植自 Quartz v4）
        graphUtils.ts  纯函数（边去重/力强度/视口计算/缓动，node:test 覆盖）
    kb/                知识库组件
      KnowledgeBasePage.tsx  知识库页面（shell 布局）
      KbFilePanel.tsx         文件面板（搜索、文件列表、vault 切换）
      KbFileTree.tsx          文件树组件
      KbMainContent.tsx       主内容区（渲染 + 排版模式 + Tab 系统 + 属性卡片）
      KbFrontmatterCard.tsx   可折叠 YAML frontmatter 属性卡片（折叠态标签 + 展开态完整字段 + wikilink 跳转）
      KbTabBar.tsx            Tab 栏
      KbModals.tsx            模态框（vault 创建/切换/导入/COSE 安装提示）
      MdRenderer.tsx          doocs/md 渲染引擎封装
      MdEditor.tsx            Markdown 编辑器
      MdTypesetEditor.tsx     左右分栏排版编辑器
      MdStylePanel.tsx        样式面板（主题/字体/颜色/选项）
      ContextMenu.tsx         右键菜单
      CreateVaultForm.tsx     Vault 创建表单
      VaultActionPanel.tsx    Vault 操作面板
      VaultList.tsx           Vault 列表
      VaultManager.tsx        Vault 管理器
      WikiChatPanel.tsx       Wiki 对话面板
    account/           账号组件（用户模块 M3；合规勾选 M5；「我的」页面化）
      AccountPage.tsx      「我的」独立页面（/me，页内 Tab：资料/已购/上架[仅管理员]；未登录直达时内嵌登录表单）
      AccountModal.tsx     登录弹窗（纯登录职责；NavRail 分流：未登录点击 → 弹窗，已登录 → 导航 /me；登录成功非意图场景自动导航 /resources 资源页，已登录点账号入口才去 /me）
      PurchasesSection.tsx 我的已购分区（/me?tab=purchases；GET /api/market/purchases + 下载按钮重复下载最新版）
      ListingsSection.tsx  我的上架分区（/me?tab=listings；查看/下架/恢复，前身 MyListingsPanel 弹层）
      LoginForm.tsx        验证码登录表单（邮箱 → 验证码两步 + 重发倒计时；注册=登录）；发送验证码前须勾选「用户协议 + 隐私政策」（个保法前置，链接 molio.cn/terms|privacy）
      authErrors.ts        daemon /api/auth 错误码 → i18n 文案映射
    channels/          渠道组件
      FeishuChannelPanel.tsx  飞书渠道面板（7 步引导 + appId/Secret 表单）
      WeixinChannelPanel.tsx  微信渠道面板（扫码登录 + default agent）
    history/           历史组件
      HistoryPage.tsx  对话历史页面
    runtimes/          运行时组件
      RuntimePage.tsx  Agent 运行时管理页面
    settings/          设置组件
      SettingsPage.tsx 设置页面
      updater-state.ts 更新状态管理
    resources/         资源模块组件
      ResourcesPage.tsx      资源列表页（筛选 pills + 卡片网格）
      ResourceDetailPage.tsx 资源详情页（概述/效果预览灯箱/导入说明/侧栏动作卡）
      ResourceCard.tsx       资源卡片
      ResourcePayModal.tsx   微信支付弹窗（QR + 轮询 + 下载交付）
      resourceAction.ts      主按钮动作分发（payUrl 外链 / 微信支付 / 免费直链）
  styles/
    tokens.css     CSS 变量 (颜色、间距、字体)
    base.css       基础重置样式
    rail.css       导航栏样式
    home.css       主页样式
    chat.css       聊天组件样式
    graph.css      知识图谱样式（画布、顶栏、minimap、加载/错误/空状态）
    knowledge.css  知识库样式（含排版编辑器、样式面板）
    channels.css   渠道页面样式
    history.css    历史页面样式
    runtimes.css   运行时页面样式
    settings.css   设置页面样式
    account.css    账号面板 + 登录表单样式（复用 kb-overlay/kb-modal/kb-btn）
    resources.css  资源页样式（列表/详情/灯箱/支付弹窗）
  e2e/
    *.spec.ts       Playwright 自动化测试（需先 pnpm dev）
    helpers/        mock-sse.ts 等测试辅助
    scenarios/      kimi-webbridge 场景文档（非自动化，手动/AI 驱动）
  vendor/
    doocs-md/       从 doocs/md vendored 的核心渲染代码
      src/
        renderer/     marked 渲染器 + 自定义扩展
        extensions/   扩展（KaTeX、Mermaid、alert、代码高亮等）
        theme/        主题系统 + CSS 处理
        utils/        工具函数
      themes/        主题 CSS（base、default、grace、simple）
      shared/        共享类型和工具
      package.json   本地包配置
  scripts/
    update-doocs-md.sh  更新 doocs/md 脚本
```

## 命令

```bash
pnpm dev          # vite dev server (:5173)
pnpm build        # vite build
pnpm preview      # vite preview
pnpm typecheck    # tsc --noEmit
pnpm test         # node:test 单测（graph engine 纯函数 + settings 迁移，Node 24 原生 TS）
pnpm test:e2e     # Playwright 自动启动隔离的 daemon/cloud/web（先关闭占用测试端口的服务）
```

## E2E 同步规则（强制）

当以下目录的文件发生变化时，**必须**检查 `apps/web/e2e/` 下是否有对应测试需要同步更新，并在同一个 commit 提交：

| 触发目录 | 对应 E2E 测试 |
|---------|-------------|
| `src/components/HomePage.tsx` | `e2e/bootstrap.spec.ts` |
| `src/components/NavRail.tsx` | `e2e/bootstrap.spec.ts`, `e2e/navigation.spec.ts`, `e2e/auth.spec.ts` |
| `src/components/account/`, `src/stores/authStore.ts` | `e2e/auth.spec.ts`, `e2e/market-community.spec.ts`, `e2e/resources.spec.ts`（登录链路共用 loginViaDevCode/登录门槛） |
| `src/components/kb/` | `e2e/publish-flow.spec.ts` |
| `src/components/graph/` | `e2e/graph.spec.ts`, `e2e/graph-settings.spec.ts`, `e2e/graph-local.spec.ts` |
| `src/components/runtimes/` | `e2e/runtimes-page.spec.ts`, `e2e/runtime-provider-config.spec.ts` |
| `src/components/settings/` | `e2e/settings.spec.ts`, `e2e/skills.spec.ts`, `e2e/skill-hub.spec.ts`, `e2e/runtimes-page.spec.ts`（RuntimesPanel 在此）, `e2e/runtime-provider-config.spec.ts` |
| `src/components/history/` | `e2e/history.spec.ts` |
| `src/components/QuizCard.tsx`, `src/utils/quiz*.ts` | `e2e/quiz.spec.ts` |
| `src/components/resources/`, `src/data/resources.ts`, `apps/landing-page/resources-data.js` | `e2e/resources.spec.ts` |
| `src/App.tsx`（路由变更） | `e2e/navigation.spec.ts`, `e2e/bootstrap.spec.ts` |

**检查步骤**：

1. 改完组件后，对照上表找到对应 E2E 文件
2. 检查测试中使用的 CSS class / `data-testid` / `data-view` 是否仍存在于新代码
3. 若路由结构变化（增删路由、改 NavRail 按钮），同步更新 `navigation.spec.ts` 和 `bootstrap.spec.ts`
4. 选择器优先级：`data-testid` > `data-view` > CSS class > 文本内容（越靠前越稳定）

## 关键设计

### 页面路由

| 视图 | 路径 | 组件 |
|------|------|------|
| 入口（非页面） | `/` | `EntryRedirect`（恢复上次路由，否则落默认落点） |
| 对话 | `/chat` | HomePage（landing / 悬浮面板活动会话的全屏态）+ ChatSessionView, ChatComposer |
| 知识库 | `/knowledge` | KnowledgeBasePage + kb/* |
| 历史 | `/history` | HistoryPage |
| 设置 | `/settings` | SettingsPage（含 RuntimesPanel、ChannelsPanel） |
| 图谱 | `/graph` | GraphPage, Minimap |
| 资源 | `/resources` | ResourcesPage（列表 + 筛选 + 微信支付弹窗） |
| 资源详情 | `/resources/:id` | ResourceDetailPage（概述/预览灯箱/导入说明） |
| 我的 | `/me` | AccountPage（Tab：资料/已购/上架[管理员]；`?tab=` 深链） |

### 历史记录 (History)

- **筛选**: 仅 vault 一个维度（agent / channel 维度已移除），下拉框直接展示在搜索栏旁。
- **搜索**: 全文搜索消息内容（FTS5 trigram + LIKE 回退），300ms debounce。
- **分页**: 游标分页（cursor = updated_at），默认 50 条/页，加载更多 append。
- **标签**: 
  - vault pill：灰色=存活，红色=已删除。vault_name 反范式化存储，vault 删除后仍可显示原名。
  - channel pill：仅非 desktop 渠道显示（绿色 `[微信]`、蓝色 `[飞书]` / `[企业微信]`）。
  - 「做过题」pill（紫色）：该会话渲染出题卡的张数 + 答对题数（`N 卡` / `N 卡 · M 对`）。数据来自 daemon 的 `quizCardCount` / `quizCorrectCount`（`apps/daemon/src/core/quiz-trace.ts`）。**判定口径与渲染器同源**——`countQuizCards` 走 contracts 里同一个 `splitContent` + `parseQuizBlock`，daemon 侧不许另写 SQL 复刻。对数为 0 时不单列（答错几道与没答过在列表里分不清）。
- **日期组**: 按日期分组，serif 字体标题，可折叠/展开，标题右侧显示该组会话数量。
- **删除**: 勾选式批量删除——行内 ⋯ 溢出菜单 →「删除」→ 进入勾选模式，被点行预勾选；勾选模式下点行主体/复选框切换勾选（跨置顶区 + 日期分组均可选），⋯ 溢出菜单隐藏；顶部浮动确认条「已选 N 条」+「取消/删除」→「删除」弹确认框 → 确认后批量删除。乐观移除 + 调 `POST /conversations/batch-delete`，失败 `refresh()` 回滚 + 3 秒 transient error。删除成功经 `onDeleteConversations` 通知 App——若删除的正是主页当前加载的会话，主页聊天会被清空。
- **缓存**: 30s stale cache，跨页切换不重复请求。
- **摘要**: 取最后一条消息，但**先剥掉题卡围栏**（`utils/historySummary.ts` → contracts 的 `stripQuizFences`）只留文字——「最后一条就是一张题卡」的会话原本直接显示裸 JSON（真实库 13 例）。剥完没文字的显示「题卡」。
- **骨架屏**: 初始加载显示 5 行 shimmer 占位。
- **对话内历史下拉**（`components/ConversationHistoryMenu.tsx`，主页输入框与 KB 会话标签栏共用）: 口径与历史页默认值**完全一致**——当前活动库 + 未归属任何库的渠道会话（复用 `historyFilterQuery.ts` 的 `initialVaultFilter` / `buildListQuery`，别再手写一套查询参数）；下拉顶部显示口径提示，无活动库时退回全量。改过滤口径要同时看 `e2e/history.spec.ts` 与 `e2e/kb-chat-sessions.spec.ts`。
- **相关文件**: `hooks/useHistoryFilters.ts`（筛选/分页/缓存/乐观删除状态管理）

### 知识库 (Knowledge Base)

- **仓库管理器（VaultManager，`.vm-*`）**: 底部 vault bar 唤起的双栏模态。左栏仓库列表，右栏品牌块 + 应用级动作卡（新建/打开）+ **当前仓库的外部素材根设置**（作用域头「当前仓库 · <名>」点名归属）。选中仓库的分支：未跨仓库 → 就地切换且**面板不收起**（`selectVault` 不隐式关面板）；已 pinned 跨仓库 → 新窗口 `?vault=<id>&manage=1`（新窗口 vault 解析后自动开管理器、随即剥参）。出口只有 ✕ / Esc / 点遮罩。改这块前先读 `docs/2026-09-08-linked-source-roots-design.md` §6.1 与 `multi-window.spec.ts`——两条路径 + URL 镜像 effect 是这段交互最容易改错的地方
- **文件面板**: 左侧文件树，支持搜索、vault 切换
- **主内容区**: 
  - **默认模式**: 直接显示 doocs/md 渲染内容
  - **排版模式**: 左右分栏编辑器（左侧 Markdown 源码，右侧实时预览）
- **右上角按钮**: 默认模式有「排版」按钮；排版模式有「退出排版」「复制」「发布」「样式」按钮
- **样式面板**: 右侧悬浮面板，支持主题、字体、字号、主题色、排版选项切换
- **渲染引擎**: 基于 doocs/md (`marked` v18 + 扩展 + 主题系统)
- **Tab 系统**: 多文件 Tab 切换，上限 20（`MAX_TABS`，达上限拦截 + toast，不静默淘汰）；溢出时左右箭头 + `▾` 下拉收纳；active tab 自动滚入可见区；状态持久化到 localStorage
- **全局悬浮对话面板** (`KbChatSessionsPanel` + `kbChatSessionsStore`)：App 层常驻挂载、任意页面可用（右下角 `FloatingChatButton` 开合）。KB 页 `💬问答` 文档级入口（`kb-btn-ask`，主内容区头部，选中文件才渲染）与 vault 级常驻入口（`kb-btn-ask-tab`，Tab 栏 actions 首位，无文件=库级问答；空状态两分支亦有「💬 与知识库问答」CTA `kb-empty-ask-cta`）/ `📚构建Wiki`（`kb-btn-build-wiki`）/ `🩺健康检查`（`kb-btn-lint-wiki`）及树右键「加入 Wiki」经 `chatPanelRef.openQa/runWikiOp` 下发，打开/激活**会话标签**（上限 `MAX_CHAT_SESSIONS`=10，**按库计**，达上限 toast 拦截）。双形态：**悬浮**（右下角，可拖移/拖宽/拖高，宽度高度位置持久化）/ **停靠侧边栏**（KB 页 = 页内分栏：文档区经 `--kb-dock-w` 让出等宽、拖宽联动重排，其余页面 = 页头下悬浮式侧边栏）。任务运行中再点入口：问答不中断（另开/激活 qa 标签）、wiki 类弹「中断/排队/取消」；关闭运行中 wiki 会话仅允许「中断并关闭」（`anyWikiRunning` 单例守卫，防 D3 并发写同一 vault）。排队复用 agent stdin 原生队列，详见 [docs/kb-chat-interrupt-queue.md](../../docs/kb-chat-interrupt-queue.md)。
- **会话标签按知识库隔离**（`kbChatSessionsStore`）：每个会话归属一个库（创建时打戳 `vaultId`，缺省=当前活跃库）。标签栏只渲染**当前库**的会话 —— 切库 → 别的库的标签不出现（切回来原样恢复，controller 重挂载后按 conversationId 从 DB 拉历史）；`vaultId: null` = 通用会话（不属于任何库，任何库都可见）；旧会话（无 `vaultId` 字段）载入时迁移到当前活跃库。活动会话按库取作用域（`getActiveSession` 不跨库），去重与上限也都按库计。**切库不再清空会话的 @文件上下文**（每个会话的 filePath 是它自己那个库的相对路径）。
- **历史下拉高亮当前会话**（`ConversationHistoryMenu`）：`activeConversationId` 命中行加 `is-current`（左侧强调条 + 浅底 + 「当前」标记，`data-current="true"`）。会话标签栏与 composer 两处都传当前会话 id —— 否则用户在历史列表里分不清自己在看哪一条。
- **会话滚动记忆**（`stores/chatScrollMemory.ts` + `ChatSessionView`）：按 conversationId 记住消息区滚动位置与贴底状态。语义拍板（2026-11-09）：**记忆存在 ⇄ 标签还开着 ⇄ 切回恢复**——切会话标签（全屏/面板）、切表面形态（全屏 ⇄ 面板：面板 view 的 `active` 计入 `panelOpen`，退出全屏/重开面板时落位）、都恢复到切换前位置；**关标签/换绑会话即删记忆 ⇄ 从历史重开贴底**（新会话无记录也贴底；「换会话回到底部」的旧行为只对无记忆的会话生效）。**位置用「锚点」表达**（视口顶第一条消息的序号 + 相对偏移，恢复时把同一条消息钉回同一视口位置）而非绝对 scrollTop——全屏 ⇄ 面板宽度不同会重新折行，绝对坐标对应的可见内容会漂移（实测 ±3 条）；锚点在同宽下同样像素精确，绝对 top 仅作锚点失效（消息被截断）的兜底。贴底态不记锚点（恢复时贴新底）。写入是持续的（scroll 事件里写，仅脱离贴底时量锚点；隐藏容器必须跳过——boxless 的 scrollTop 恒 0 会把记忆污染成顶部）；恢复走 useLayoutEffect（paint 前落位，全屏切标签不闪底部一帧）+ rAF 补一次（代码块次帧才量出高度）。与 KB 文档标签的 `useScrollMemory`（「切回必须恢复阅读位置」）同哲学。回归：`e2e/chat-scroll-memory.spec.ts`（含宽度切换的内容锚定断言）。

- **单库分屏副视图图谱（对照）**：副格图谱为**纯 file-scope**，始终跟随主格当前文档
  （`companionScope = kb.selectedFile ? {type:'file', path} : null`，useMemo 稳定身份防无限重取），主格换文档自动重锚定。
  无 dir-scope、无「回到当前文档」按钮、不接 `onNodeOpen`/`onScopeReset`——单击图中节点即打开对应文件到主格
  （悬停高亮关联，三处图谱一致）。**取景与主格不同**（传 `companion` prop）：小参照面板 + 随主格文档
  **高频重锚定** → 用 `fitView` 框住**整张子图**（而非 file-scope 的圆心居中放大——小画布下会裁掉邻居），
  且 `engine.preSettle()` 同步跑完布局 + 瞬时取景，**不做过渡动画**（两段式「先落位、收敛后再动画」在高频
  切换下只会拖沓）。回归：`e2e/graph-camera.spec.ts` 的 companion 用例（数据一到即框全 + 3.5s 内视口不变）。
- **副视图图谱不渲染顶栏导航箭头**（`graph-nav-navigation` 为 0，前进/后退为主格图谱 tab 专属），关闭走图谱自己的悬浮 `companion-close` chip。
- **局部知识图谱（主格图谱 tab）**：树右键文件/文件夹「查看局部图谱」（`kb-ctx-local-graph`，文件/文件夹均有、永不置灰）
  进入主格图谱 tab（`data-testid="kb-graph-pane"`），交互见下方「知识图谱」节。

### 知识图谱 (Graph View)

- **渲染引擎**: PixiJS 8 (WebGL) + d3-force 仿真，**忠实移植 Quartz v4 的
  `graph.inline.ts`（MIT）**，核心在 `engine/pixiGraphEngine.ts`：
  per-node / per-link Graphics（d3 只算坐标，Pixi 每帧同步位置）；标签 Text 用
  `resolution: devicePixelRatio * 4` 高分辨率栅格化（缩放不糊）；手动 rAF 渲染循环
  （`app autoStart: false`），节点坐标 + 画布中心偏移
- **力模型（Quartz 全局图配方）**: forceLink（距离 30，强度 0=d3 按度数加权）+
  forceManyBody（-50）+ forceCenter（0.2）+ forceCollide（iterations=3）+ forceRadial（0.2）
  —— 默认值见 `types.ts` 的 `DEFAULT_FORCE_PARAMS`（v3）
- **交互（d3-zoom + d3-drag，Obsidian 标准 d3-force 拖拽）**: d3-zoom 缩放/平移/触控 pinch；d3-drag
  节点拖拽。**对齐 Obsidian 官方的标准做法**（调研结论）：只钉被拖节点 fx/fy，**整图自由流动**，用
  `DRAG_ALPHA_TARGET(0.2)` 中温保温（区别于 Quartz 移植版 `alphaTarget(1.0)` 力满负荷→高频抖）。
  mousedown 只记录起点、只钉被拖节点（sim 静止时点击零运动）；mousemove 过 `DRAG_THRESHOLD(4px)` 才
  `activateDragFluid`——`alphaTarget(0.2).restart()` 让整图持续温动贴合拖拽；被拖节点 fx/fy 钉跟光标。
  松手 `endDragFluid`：`alphaTarget(0)` 冷却 → 整图（含被拖节点，fx/fy 复位为 null）自然沉降、**边像
  弹簧一样回弹收敛**（不钉落点、不冻结）。**稠密图/hub 专用稳定**（只在度数>60 / 间距<20 才介入，
  不破坏整图流动的 Obsidian 手感）：
  ①被拖节点 collide 半径临时调小（`radius+PAD`，防 deg683 超大 hub 拖拽时碾压集群→电荷爆）、
  ②拖拽期 link×`DRAG_LINK_MULT(0.4)`（683 条弹簧把整图拽向内收缩）、③`velocityDecay(0.6)` 高阻尼扑灭
  振荡；松手恢复 collide 半径/link/damping 到 rest。叠加全局物理保险丝：`manyBody.distanceMin(20)`
  封掉拖拽级联的 1/d² 电荷爆、collide 半径 `COLLIDE_MAX(100)` 封顶、super-hub（度数>60）的 link 按
  `1/√max(deg)` 减弱（防「683 条源边把 hub 甩飞」）。**悬停高亮关联、单击打开文章**（`onNodeClick` → `openNode`，
  三处图谱一致，与 Obsidian 原生图谱同款）；死链节点单击新建空白页再打开；双击空白 fit
- **拖拽降质（拖拽期）**: `setMotionMode(true)` → 隐藏标签（`syncLabels` 跳过）+ minimap 重绘监听暂停
  （collide 迭代**不降级**，保帧也保弹簧手感）；松手恢复
- **hover 两档细化（M3-⑦）**: `@tweenjs/tween.js` 做 hover/选中时动画（200ms），非邻居 alpha
  淡出 + **尺寸两档缩小**（hover 75% / 选中 60%）+ 焦点节点放大（hover 1.2× / 选中 1.4×，
  hover 时关联节点微缩 0.85）；关联边 `zIndex:1` 置顶不被淡化边遮挡；hover 离开 **150ms 迟滞**
  （跨节点移动不闪烁）。颜色插值暂未 tween（靠 alpha+scale 承担分化）
- **搜索定位**: 顶栏搜索框在可见节点内模糊匹配，选中后 `focusNode` 平滑居中缩放 k=1.5
- **Minimap**: 订阅引擎 render 事件按需重绘（无 rAF 轮询），支持点击跳转/拖拽视口导航
- **数据链路**: daemon `GET /api/graph/:vaultId` 解析 `[[wikilink]]` → GraphPage 筛选
  （类型/孤立节点/死链接）→ `engine.setData()`
- **局部图/图谱范围（graphScope）**: GraphPage 接收 `graphScope?: GraphScope`（`@molio/contracts`）——
  `null`（默认）= 全量图；`{type:'file', path}` = 当前文档 1 跳邻域（`GET /api/graph/:vaultId/local`，响应含
  `focusNodes`）；`{type:'dir', path}` = 文件夹子图。**两套交互共用**：对照副视图只传 file-scope
  （`companionScope`，纯跟随主格文档），主格图谱 tab 传 `graphTabScope`（file/dir，树右键「查看局部图谱」写入）。
  setData 后按 scope 取景分派：file → `fitView` **框全 1 跳邻域** + `selectNode(focusNodes[0])` 选中圆心做视觉锚点
  （圆心不存在或被筛选滤掉则只 `fitView`）；dir → `fitView`。**不再用 `focusNode(k=1.5)` 圆心居中放大**——
  大 hub 下那会裁掉外圈邻居（回归：`e2e/graph-camera.spec.ts` 的 file-scope 用例）。
  **筛选三开关（类型/孤立/死链）照常复用于局部数据**；空数据翻 `hasData` 必须 `engine.setData([],[])` 清引擎。
- **空态文案按 scope 细分**（GraphPage `emptyCopy`）：全量图 →「该知识库中没有 Markdown 文件」；
  file-scope 且是普通 .md →「这篇笔记还没有链接」；file-scope 且非 .md 或 index/log 类 →「该文件不在关系图谱中」；
  dir-scope →「该文件夹下没有 Markdown 笔记」。原因：局部图空态若沿用全量图那句，会误导成「整个库没有 md」。
  （`GRAPH_EXCLUDED_BASENAMES` 是 daemon `routes/graph.ts` 的镜像，只用于挑文案，不参与过滤。）
- **scope 切换的取景（两方向统一）**：布局在收敛前一直在动，**早取景会落在错误位置**（这是「切换后视角不对、
  且看不到初始化过渡」的根因）。故 scope 切换（局部图 ⇄ 全量图）时：先 `applyView(false)` **立即落位**（非动画，
  先给个合理视角），再 `engine.reframeAfterSettle(fn)` 注册**收敛后的动画取景**（file→框全邻域+选中圆心、dir/全量→fit），
  平滑过渡到正确视角。同 scope 内筛选变化仍直接动画取景。用户中途平移/缩放则放弃这次自动取景（让位用户）。
  回归保护：`e2e/graph-camera.spec.ts`（断言收敛后视口变了 **且** 框住全部节点）。
- **节点交互（三处统一）**：**悬停 = 高亮关联**（引擎 hover 两档，非邻居淡化 + 关联边置顶）；
  **单击 = 打开文章**（死链节点新建空白页再打开）；双击空白 = fit。三处图谱（全量图 / 局部知识图谱 / 对照）
  行为完全相同——**不提供「单击选中」**：它与悬停高亮重复，而「看邻域」已由局部知识图谱专门承担（Obsidian 同款）。
  `graphScope && onScopeReset` 时顶栏渲染「回到全量图」按钮（`graph-scope-back`，文案 `graph.scopeBack`）。
  `graphTabScope`（KBP useState）生命周期：关图谱 tab（`!graphTabOpen`）/ 切 vault / 点「回到全量图」复位为 null；
  tab 间切换（keep-alive）保留。
- **React 性能**: 坐标计算和渲染帧循环在引擎内部闭环，零 React re-render

### 聊天 (Chat)

- **Shell 布局**: NavRail (左侧导航) + 主内容区
- **聊天流程**: 选择 agent → 输入消息 → POST /api/runs → 订阅 SSE → 实时渲染事件
- **消息模型**: user / assistant / error，assistant 消息包含 thinking、tools、usage
- **消息级交互**（hover 显隐 toolbar）: 复制（消息/代码块）、重新生成（末条）、编辑用户消息重发（末条）、继续生成（末条）、保存到知识库（一键存为 KB 新文件）、删除（⋯ 菜单，配对绑定 + 勾选态 + 顶部确认条）
- **代码块**: 拆分渲染——文本段走 `renderMarkdown`，fenced 代码段走 `<CodeBlock>`（语言标签 + 复制 + >20 行折叠）
- **引用来源条** (`SourceChips.tsx` + `utils/inlineSources.ts`): 助手回复底部的「这条答案读了什么」。两种形态：
  - **平铺**（≤ 8 项）：一行 chip，与旧形态逐像素一致 —— 轻场景零变化。
  - **台账**（> 8 项）：`引用 N 项` 标题行（整条可折叠）+ **可查证层**（库内文档 + 外部链接，chip）+ **其余层**（媒体数据 / 过程产物 / 索引日志 / 库外 / 检索模式，各一行计数、按需展开，条目是无边框文字而非 chip）。
  - 口径分层在 `groupInlineSources()`：按归一化路径去重（`a.md` / `./a.md` / 绝对路径算同一条）、同名文件带父目录消歧、库外与检索模式不可导航（点开必然失败）。Bash 命令解析残渣（`=`、`n:')`、`media-$f.md`）在 `toolRefs.extractSources` 里过滤 —— **展示层过滤，不动 `bashReadPaths` 的记账口径**（那个函数是 daemon `citations.ts` 的镜像实现，改了会污染 IM 出站清单与 E1 对账基线）。
  - **库内/库外/过程目录三分**（`toolRefs.classifySourceLocation`）：**不要**用 `classifyWritePath` 判库外 —— 它的 hidden 层把「真库外」与「库内点开头目录」（`.molio/wiki-build/`、`.claude/`）混为一谈，而后者在 wiki 构建里是主力（转写中间产物全在那儿）。判据：相对路径恒在库内（run 的 cwd 就是库根，见 `KbChatSessionController` 传 `vaultPath`）；绝对路径剥不掉库前缀才是真库外；库内点目录 = 过程产物（在库内、可导航，但不是用户内容）。
  - 回归测试：`src/utils/inlineSources.test.ts`（单测）+ `e2e/source-chips-ledger.spec.ts`（E2E）
- **产出区** (`WorkCompleteBanner.tsx`): 与引用区同构 —— > 8 项也走台账形态（标题带计数、可折叠、分批铺开）。产出全是文档，不需要分层。E2E 见 `source-chips-ledger.spec.ts`。
- **会话产出面板的引用 tab** (`SessionOutputPanel.tsx` + `utils/sessionSources.ts`): 与消息内联引用区同口径 —— 媒体与数据文件折进「媒体与数据」折叠组（一次 wiki 构建能读几百个，全灌进主列表会决堤）。库外/检索路径仍进 omitted（点不开，面板必须明说）。
- **SSE**: 通过 `EventSource` 订阅 daemon 事件流，实时更新消息状态

### 题库 (Quiz)

- **题卡** (`QuizCard.tsx` + `utils/quiz.ts` / `quizAnswer.ts`): 模型输出 `quiz` 围栏 JSON → 聊天内渲染可作答题卡，**判分全在前端**，不依赖 runtime 工具。题型 single / multiple / judge / fill / subject；大题（subject）的「你的答案」正文由 `pairSubjectAnswers` 按锚点配对（`quizSubjectStore` 同源）。
- **协议与围栏扫描在 `@molio/contracts`**（`packages/contracts/src/quiz.ts` + `messageSegments.ts`）: `utils/quiz.ts` 与 `utils/markdown.ts` 只是转发层。**原因**：daemon 侧统计「渲染出几张题卡」必须与渲染器同口径，SQL 复刻会漂移（实测过）。改 `splitContent` / `parseQuizBlock` 时同步想一下 daemon 的用法（`countQuizCards`）。
- **「存为题库」是手动出口，不做自动落库**：拍板结论——题目质量不稳定，存不存由用户判断（自动落库会稀释题库信噪比）。所以这里只把手动流程做厚，不新增页面/导航（「错题本」形态明确不做）。
- **保存范围** (`utils/quizSaveScope.ts` 纯函数): 错题优先 `wrong`（默认）/ 全部 `all` / 自己挑 `pick`。`wrongCount === 0`（未作答或全对）时「只存做错的」按钮**按设计不渲染**，不是 bug。大题按批改分数判三态——`gradeQuiz` 对 subject 恒 `correct: false`，不能拿来当错题判据。
- **vault 归属跟随会话，不跟随当前活动库**：`KbChatSessionController` 按 `conversationId` 向 daemon 取 `conversations.vault_id` → `Conversation.vaultId` → `ChatSessionView` → `AssistantMessage` → `QuizCard`，取不到才回落 `useActiveVaultId()`。会话标签上的 `vaultId` 是「打开标签那一刻的活动库」，跨库打开历史会话会存进别人的库。
- **文件格式** (`utils/quizFile.ts`): 落 `题库/<日期>-<标题>.md`（同名 `-2` / `-3` 去重）。frontmatter 带 `quiz_fingerprint` / 题号清单 / 出处，正文逐题写题干、选项、答案、你的答案、解析——人读，也能被后续组卷反向解析。模型产出的标量一律 JSON 引号包裹（标题含 `: ` 会写出非法 YAML，front-matter 解析失败会让整篇回落成正文）；图片路径补一层 `../`（`题库/` 是子目录）。
- **存档结果行**: 成功回「已存 N 题 · 路径」；动作（打开 / 在资源管理器中显示 / 撤销）只开 **6s 反馈窗**（与 `SaveToKbButton` 一致），过后只剩静态路径；键盘焦点进入按钮区时取消窗口（否则读到一半按钮被抽走、焦点跌回 body）。「在资源管理器中显示」仅桌面壳（`isRevealAvailable()`）。撤销 = 直接删文件，无二次确认。
- 回归：`test/quiz*.test.ts`（纯函数）+ `e2e/quiz.spec.ts`（P0）

## 与 daemon 的交互

- HTTP 请求发往 `http://localhost:3100/api/*`
- SSE 事件流: `GET /api/runs/:id/events`
- CORS 已配置允许 `localhost:5173`

## doocs/md 集成

### Vendor 方式

`@md/core` 未发布到 npm，已将核心代码 vendor 到 `vendor/doocs-md/`，配合更新脚本：

```bash
# 从上游更新（默认 main 分支）
./scripts/update-doocs-md.sh

# 指定版本
./scripts/update-doocs-md.sh v2.1.0
```

### 组件架构

- **MdRenderer**: 封装 doocs/md 渲染引擎，提供 React 组件接口。负责：
  - 调用 `applyTheme()` 生成主题 CSS，注入 `<style id="md-theme">`
  - 加载 `codeBlockTheme` URL（highlight.js 主题），追加到同一 `#md-theme` 元素
- **MdEditor**: Markdown 编辑组件
- **MdTypesetEditor**: 左右分栏编辑器，左侧 Markdown 源码，右侧实时预览
- **MdStylePanel**: 样式配置面板，支持主题、字体、字号、颜色、选项切换

### CSS 注入与复制/发布流程

**核心原则：所有排版 CSS 统一存放在 `<style id="md-theme">` 中。**

- `applyTheme()` → `ThemeInjector.inject()` → 写入 `#md-theme`（主题 CSS + 标题样式 + 用户自定义）
- `MdRenderer` → 加载 `codeBlockTheme` CSS → 追加到 `#md-theme`（代码高亮 CSS）
- `copyToClipboard` / `publishToChrome` → 只读 `#md-theme` → 自动包含全部 CSS

**`#output` 作用域处理：**

- 预览时：CSS 规则使用 `#output h1 { ... }` 前缀（`wrapCSSWithScope`），防止污染 Molio UI
- 导出时：剥离 `#output ` 前缀（`css.replace(/#output\s+/g, '')`），因为粘贴目标（微信等）没有 `#output` wrapper

**不要做的事：**
- 不要创建独立的 `<style>` 标签存放额外 CSS——publish/copy 只认识 `#md-theme`
- 不要在 `copyToClipboard` / `publishToChrome` 中遗漏 CSS 的 `#output` 剥离
- `base.css` 中的样式必须加 `#output` 前缀（与主题 CSS 一致）

### 依赖

```json
{
  "marked": "^18.0.4",
  "highlight.js": "^11.11.1",
  "front-matter": "^4.0.2",
  "isomorphic-dompurify": "^3.15.0",
  "es-toolkit": "^1.47.0",
  "fflate": "^0.8.3",
  "pixi.js": "^8.19.0",
  "d3-force": "^3.0.0",
  "d3-selection": "^3.0.0",
  "d3-drag": "^3.0.0",
  "d3-zoom": "^3.0.0",
  "@tweenjs/tween.js": "^25.0.0"
}
```
