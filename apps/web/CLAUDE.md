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
    useChat.ts         聊天状态管理 (消息、发送、SSE 订阅)
    useChatCore.ts     聊天核心逻辑
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
  components/
    HomePage.tsx       主页：agent 选择 + 聊天面板
    NavRail.tsx        左侧导航栏
    ChatPane.tsx       聊天消息列表
    ChatComposer.tsx   消息输入框
    UserMessage.tsx    用户消息气泡
    AssistantMessage.tsx 助手消息气泡 (thinking + tool cards)
    ThinkingBlock.tsx  思考过程折叠块
    ToolCard.tsx       工具调用卡片
    ToolGroup.tsx      工具调用分组
    MessageToolbar.tsx 消息操作条（复制/重生成/继续/编辑/删除，hover 显隐）
    OverflowMenu.tsx   ⋯ 溢出菜单（收纳低频动作）
    CodeBlock.tsx      代码块（语言标签 + 复制 + 长代码折叠）
    SaveToKbButton.tsx 一键保存助手回复到当前知识库
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
pnpm test:e2e     # Playwright E2E 测试（需先运行 pnpm dev）
```

## E2E 同步规则（强制）

当以下目录的文件发生变化时，**必须**检查 `apps/web/e2e/` 下是否有对应测试需要同步更新，并在同一个 commit 提交：

| 触发目录 | 对应 E2E 测试 |
|---------|-------------|
| `src/components/HomePage.tsx` | `e2e/bootstrap.spec.ts` |
| `src/components/NavRail.tsx` | `e2e/bootstrap.spec.ts`, `e2e/navigation.spec.ts` |
| `src/components/kb/` | `e2e/publish-flow.spec.ts` |
| `src/components/graph/` | `e2e/graph.spec.ts`, `e2e/graph-settings.spec.ts` |
| `src/components/runtimes/` | `e2e/runtimes-page.spec.ts`, `e2e/runtime-provider-config.spec.ts` |
| `src/components/settings/` | `e2e/runtimes-page.spec.ts`（RuntimesPanel 在此） |
| `src/components/history/` | `e2e/history.spec.ts` |
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
| 主页 (聊天) | `/` | HomePage, ChatPane, ChatComposer |
| 知识库 | `/knowledge` | KnowledgeBasePage + kb/* |
| 历史 | `/history` | HistoryPage |
| 设置 | `/settings` | SettingsPage（含 RuntimesPanel、ChannelsPanel） |
| 图谱 | `/graph` | GraphPage, Minimap |
| 资源 | `/resources` | ResourcesPage（列表 + 筛选 + 微信支付弹窗） |
| 资源详情 | `/resources/:id` | ResourceDetailPage（概述/预览灯箱/导入说明） |

### 历史记录 (History)

- **筛选**: 仅 vault 一个维度（agent / channel 维度已移除），下拉框直接展示在搜索栏旁。
- **搜索**: 全文搜索消息内容（FTS5 trigram + LIKE 回退），300ms debounce。
- **分页**: 游标分页（cursor = updated_at），默认 50 条/页，加载更多 append。
- **标签**: 
  - vault pill：灰色=存活，红色=已删除。vault_name 反范式化存储，vault 删除后仍可显示原名。
  - channel pill：仅非 desktop 渠道显示（绿色 `[微信]`、蓝色 `[飞书]` / `[企业微信]`）。
- **日期组**: 按日期分组，serif 字体标题，可折叠/展开，标题右侧显示该组会话数量。
- **删除**: 两步确认——点击删除 → 行变红色确认态 → 确认/取消。失败回滚 + 3 秒 transient error。
- **缓存**: 30s stale cache，跨页切换不重复请求。
- **骨架屏**: 初始加载显示 5 行 shimmer 占位。
- **相关文件**: `hooks/useHistoryFilters.ts`（筛选/分页/缓存/乐观删除状态管理）

### 知识库 (Knowledge Base)

- **文件面板**: 左侧文件树，支持搜索、vault 切换
- **主内容区**: 
  - **默认模式**: 直接显示 doocs/md 渲染内容
  - **排版模式**: 左右分栏编辑器（左侧 Markdown 源码，右侧实时预览）
- **右上角按钮**: 默认模式有「排版」按钮；排版模式有「退出排版」「复制」「发布」「样式」按钮
- **样式面板**: 右侧悬浮面板，支持主题、字体、字号、主题色、排版选项切换
- **渲染引擎**: 基于 doocs/md (`marked` v18 + 扩展 + 主题系统)
- **Tab 系统**: 多文件 Tab 切换，上限 20（`MAX_TABS`，达上限拦截 + toast，不静默淘汰）；溢出时左右箭头 + `▾` 下拉收纳；active tab 自动滚入可见区；状态持久化到 localStorage
- **统一聊天面板** (`KbChatPanel` + `useKbChat`)：`💬问答`（文档级，`kb-main-header`）/ `📚构建Wiki`·`🩺健康检查`（vault 级，`KbTabBar` 尾部）。任务运行中再点入口：问答不中断、wiki 类弹「中断/排队/取消」。排队复用 agent stdin 原生队列，详见 [docs/kb-chat-interrupt-queue.md](../../docs/kb-chat-interrupt-queue.md)。

### 知识图谱 (Graph View)

- **渲染引擎**: PixiJS 8 (WebGL) + d3-force 仿真，**忠实移植 Quartz v4 的
  `graph.inline.ts`（MIT）**，核心在 `engine/pixiGraphEngine.ts`：
  per-node / per-link Graphics（d3 只算坐标，Pixi 每帧同步位置）；标签 Text 用
  `resolution: devicePixelRatio * 4` 高分辨率栅格化（缩放不糊）；手动 rAF 渲染循环
  （`app autoStart: false`），节点坐标 + 画布中心偏移
- **力模型（Quartz 全局图配方）**: forceLink（距离 30，强度 0=d3 按度数加权）+
  forceManyBody（-50）+ forceCenter（0.2）+ forceCollide（iterations=3）+ forceRadial（0.2）
  —— 默认值见 `types.ts` 的 `DEFAULT_FORCE_PARAMS`（v3）
- **交互（d3-zoom + d3-drag，Quartz 同款）**: d3-zoom 缩放/平移/触控 pinch；
  d3-drag 节点拖拽（<500ms 判为点击）；单击选中（焦点模式）、双击节点打开文件、
  双击空白 fit
- **焦点模式动画**: `@tweenjs/tween.js` 做 hover/选中时非邻居节点/边的 alpha 平滑淡出（200ms）
- **搜索定位**: 顶栏搜索框在可见节点内模糊匹配，选中后 `focusNode` 平滑居中缩放 k=1.5
- **Minimap**: 订阅引擎 render 事件按需重绘（无 rAF 轮询），支持点击跳转/拖拽视口导航
- **数据链路**: daemon `GET /api/graph/:vaultId` 解析 `[[wikilink]]` → GraphPage 筛选
  （类型/孤立节点/死链接）→ `engine.setData()`
- **React 性能**: 坐标计算和渲染帧循环在引擎内部闭环，零 React re-render

### 聊天 (Chat)

- **Shell 布局**: NavRail (左侧导航) + 主内容区
- **聊天流程**: 选择 agent → 输入消息 → POST /api/runs → 订阅 SSE → 实时渲染事件
- **消息模型**: user / assistant / error，assistant 消息包含 thinking、tools、usage
- **消息级交互**（hover 显隐 toolbar）: 复制（消息/代码块）、重新生成（末条）、编辑用户消息重发（末条）、继续生成（末条）、保存到知识库（一键存为 KB 新文件）、删除（⋯ 菜单，配对绑定 + 勾选态 + 顶部确认条）
- **代码块**: 拆分渲染——文本段走 `renderMarkdown`，fenced 代码段走 `<CodeBlock>`（语言标签 + 复制 + >20 行折叠）
- **SSE**: 通过 `EventSource` 订阅 daemon 事件流，实时更新消息状态

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