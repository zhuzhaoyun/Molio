# 图标系统统一：现状、方案、实现与验收

> 日期：2026-11-14。状态：已完成。
> 范围：`apps/web` 的功能图标、Molio 品牌标识、Agent 产品标识及相关样式。
> 交付方式：所有实现与审查修正合并为一个独立可发布提交。

## 1. 背景与问题

改造前，界面同时存在三类图形：项目已有的线性 SVG、直接写在 JSX 中的 emoji、运行时 Agent 的色圆点。正式 Molio logo 已存在于 `public/images/main.png`，部分品牌位置却使用 📚。同一 📄 在文件树中呈灰白色，在文档属性中呈彩色，颜色、字重和基线由操作系统决定，无法跟随主题。

主要问题如下：

1. 正式 logo、彩色书堆 emoji 和线性书形同时承担品牌表达。
2. 功能图标混用 SVG 与 emoji，视觉重量、尺寸和基线不一致。
3. emoji 无法使用设计 token，深浅色主题下不可控。
4. Agent 标识依赖颜色和厂商图形，无法准确表示具体产品。
5. `RuntimePage` 与 `RuntimesPanel` 各维护一份 Agent 图标映射。
6. 部分原有图标语义不准确，例如书签表示入库、齿轮表示构建 Wiki、禁止符号表示未展示来源。

## 2. 改造前完整盘点

盘点覆盖 `apps/web/src` 的 emoji 字符及关键渲染位置，分为七类。

| 类别 | 主要位置 | 改造前表现 |
|---|---|---|
| 品牌标识 | 主页、设置页、知识库管理面板、导航栏 | `main.png`、📚、线性书形并存 |
| 功能图标 | 会话标签、文档属性、大纲、搜索、排版宽度、Provider 配置、账号编辑 | 💬⚙️📝✍️📋📅🔄📰📂🏷🔗📌 等 |
| 文件图标 | 文件树、文件引用、导入冲突、超大文件、附件与导入列表 | 📁📄🖼️📕📝，部分位置附加彩色角点 |
| 语义徽章 | 实体、概念、数据源、对比、问答、微信、剪藏、作者与关联计数 | 📌💡📰⚖️❓📱📎✍️🔗 |
| Agent 标识 | 运行时页面与设置中的运行时面板 | 🟣🟢🔵🟠🟤🐳，未知 Agent 使用 ⚙️ |
| 空状态 | 知识库、文件树、运行时、运行记录、技能与技能商店 | 🏗📥📚📄📂🔍📭🧩🛍️ |
| 状态与排版符号 | 耗时、查看原图、新建、写入、登录状态、加载错误 | ⏱↗＋✎✅⚠ |

明确不属于本次替换范围的内容：

- 发给 AI 的 prompt 文本。
- 市场上架数据自带的用户内容图标。
- 用户文档中的 emoji。
- 排版符号 `⏱`、`↗`、`＋`；账号昵称编辑等界面功能图标已统一为 SVG。
- 源码注释。

## 3. 设计目标与最终决策

- 功能与语义图标统一使用 SVG，颜色通过 `currentColor` 或 CSS 类跟随主题。
- 新增及调整的线性图标全部采用 Lucide 官方图形，保留项目已有的 24 viewBox、1.9 描边和圆角线帽，不自绘。
- Molio 品牌统一使用正式 `main.png`，由 `BrandLogo` 组件渲染。
- Agent 使用具体产品的官方资源；未知 Agent 才使用 `RobotIcon` 兜底。
- 文件类型通过图形、颜色和文字共同表达，不只依赖颜色。
- 图标按真实产品意图选择，不沿用原有错误语义。
- 保留既有 `data-testid`、CSS 类与按钮可访问名称，避免图形替换影响交互和测试选择器。
- 实施过程可以分批验收，仓库最终只保留一个完整提交，不保留被后续审查推翻的中间方案。

## 4. 方案演进与取舍

下表保留过程文档中的关键决策及最终结论，避免把早期建议误当成当前实现。

| 讨论项 | 早期方案或问题 | 最终结论 |
|---|---|---|
| 功能图形来源 | 按既有 Feather 风格补充图形 | 全部使用 Lucide 官方 path；Lucide 与项目原有图形调性一致 |
| 文件图标 | 保留「emoji + 色点」的小尺寸饱满感 | 改为共享线性图形，文件夹琥珀色、文档蓝色，颜色由 CSS 类维护 |
| Agent 标识 | 字母标、简化品牌图形或上游厂商 logo | 使用各 Agent 产品级官方资源 |
| 构建 Wiki | 齿轮、Sparkle、Library 等候选 | 入口、会话标签和空状态统一 `BookIcon` |
| 信息来源 | 文件或外链箭头 | `QuoteIcon` 表达引用与出处；`related` 保留 `LinkIcon` |
| 保存到知识库 | 书签 | `BookPlusIcon` 表达新增知识库文档 |
| 未展示来源 | 禁止符号 | `EyeOffIcon` 表达未展示或不可导航 |
| 本地导入 | 下载托盘 | 知识库使用 `FolderInputIcon`，技能使用 `FileUpIcon` |
| PDF 文件引用 | 红色文件图形 | 中性 `FileBadgeIcon`，避免把文件类型误读为错误状态 |
| 实施与提交 | 多个功能批次 | 分批截图验收，最终 squash 为一个提交 |

早期开放问题的结论：推翻文件 emoji 方案；Agent 使用官方产品图形；品牌统一到 `main.png`，导航栏书形继续作为功能图标保留。

## 5. 最终实现

### 5.1 功能图标

`apps/web/src/components/icons.tsx` 集中维护线性 SVG 组件，调用方通过 `size` 控制尺寸。图形来源为 Lucide 官方 `lucide-static`（ISC 许可）。

主要组件包括：

- 会话与知识库：`ChatIcon`、`BookIcon`、`BookPlusIcon`。
- 文件与字段：`FileIcon`、`FolderIcon`、`ListIcon`、`TagIcon`、`LinkIcon`、`QuoteIcon`、`BracesIcon`。
- 日期：`CalendarPlusIcon`、`CalendarClockIcon`、`CalendarCheck2Icon`。
- 操作与状态：`ScanSearchIcon`、`FolderInputIcon`、`FileUpIcon`、`EyeOffIcon`、`WarningIcon`。
- 内容类型：`BulbIcon`、`NewsIcon`、`ScaleIcon`、`QuestionIcon`、`BoxIcon`、`PaperclipIcon`、`PhoneIcon`。
- 空态与兜底：`RobotIcon`、`PuzzleIcon`、`InboxIcon`、`SearchIcon` 等。

### 5.2 文档属性

`KbFrontmatterCard.tsx` 将「字段 → emoji 字符串」改为「字段 → SVG 组件」映射，图标以 14px 渲染，并通过 `.kb-fm-key-icon` 与字段名对齐。

| 字段 | 最终图标 |
|---|---|
| title | `FileIcon` |
| source / sources | `QuoteIcon` |
| author | `UserIcon` |
| description | `ListIcon` |
| created / updated / published | `CalendarPlusIcon` / `CalendarClockIcon` / `CalendarCheck2Icon` |
| category | `FolderIcon` |
| tags | `TagIcon` |
| related | `LinkIcon` |
| 未知字段 | `BracesIcon` |

### 5.3 会话标签与知识库入口

- 问答入口和问答会话标签统一 `ChatIcon`。
- 构建 Wiki 入口、会话标签和空状态统一 `BookIcon`。
- 齿轮只保留在 Provider 配置等真正的设置场景。
- Wiki 健康检查使用 `ScanSearchIcon`，表达扫描内容问题。

### 5.4 文件、徽章与附件

- `FileIcons.tsx`：文件夹使用琥珀色 `FolderIcon`，文档使用蓝色 `FileIcon`；颜色由 `FileIcons.css` 类管理。
- Wiki 徽章：实体 `BoxIcon`、概念 `BulbIcon`、数据源 `NewsIcon`、对比 `ScaleIcon`、问答 `QuestionIcon`、关联数量 `LinkIcon`。
- 微信、作者、剪藏分别使用 `PhoneIcon`、`UserIcon`、`PaperclipIcon`。
- DOCX 附件使用 `FileType2Icon`；PDF 引用使用 `FileBadgeIcon`；未知附件不再画成文件夹。

### 5.5 操作与空状态

- 保存回答到知识库使用 `BookPlusIcon`。
- 未展示来源使用 `EyeOffIcon`。
- 知识库导入使用 `FolderInputIcon`，技能导入使用 `FileUpIcon`。
- 文件树、仓库列表、技能、运行时、运行记录和对话空态统一为线性图标，颜色使用 `var(--text-muted)`，按场景使用 32–44px 尺寸与克制透明度。

### 5.6 Molio 品牌

`apps/web/src/components/BrandLogo.tsx` 是唯一品牌入口，统一使用 `public/images/main.png`。

- `HomePage`、`UpdateSettings` 与 `FloatingChatButton` 删除各自重复的 URL 常量，统一复用 `BrandLogo`。
- `VaultActionPanel` 的彩色书堆 emoji 改为同一正式 logo。
- 首次启动引导的旧 📚 已随当前 main 中该组件移除而消失，无需额外处理。

### 5.7 Agent 产品标识

`apps/web/src/components/runtimes/agentIcons.tsx` 的 `AgentIcon` 同时服务 `RuntimePage` 与 `RuntimesPanel`，替代两份重复的 emoji 映射。

| Agent | 最终资源 | 来源与语义 |
|---|---|---|
| Claude | `claude.svg` | Claude 官方星芒 |
| Codex | `codex.png` | Codex 桌面应用产品图标，不使用 OpenAI 花结 |
| Gemini | `googlegemini.svg` | Gemini 产品图形 |
| Qwen Code | `qwen.svg` | QwenLM/qwen-code 官方 `qwen-code-logo.svg` |
| DeepSeek Harness | `dsh.svg` / `dsh-dark.svg` | deepseek-ai/deepseek-harness 官方 favicon，不使用 DeepSeek 厂商鲸 |
| Hermes | `hermes.svg` / `hermes-dark.svg` | NousResearch/hermes-agent 官方 `icon-master.svg` / `icon-master-dark.svg` |
| 未知 Agent | `RobotIcon` | 仅在无已知产品标识时兜底 |

资源统一位于 `apps/web/public/images/agents/`。DSH 与 Hermes 的深浅色资源同时覆盖显式 `[data-theme="dark"]` 和默认「跟随系统」的 `prefers-color-scheme` 两条路径；没有深色变体的产品保持显示原资源。

## 6. 样式与主题

- 属性图标 14px、徽章图标约 13px；文件树图标透明度 0.68，空状态透明度约 0.45。
- 内联 SVG 通过 `inline-flex` 或 `vertical-align` 与文字对齐。
- 运行时卡片移除 emoji 时代遗留的底色方框，产品 logo 直接显示。
- `.agent-icon--dark` 默认隐藏；深色主题下只隐藏确实存在深色后继资源的浅色图，避免无变体 logo 消失。
- 图标形状与语义色分离，文件类型同时保留文字信息。

## 7. 审查过程与修正结果

视觉、代码和产品语义分别经过独立审查。最终提交已包含以下修正：

| 审查发现 | 修正结果 |
|---|---|
| 自绘图形走形、调性不统一 | 新增及调整的线性图标全部改用 Lucide 官方 path |
| 前后截图编号数量或含义不一致 | 全部重拍并复核，编号一一对应 |
| Before / After 代码基线不同 | Before 固定为同一 main 基线，After 使用最终代码，同环境同步骤重拍 |
| 属性、徽章、空态尺寸与对齐不一致 | 统一尺寸、间距、透明度和垂直对齐规则 |
| 运行时产品 logo 被方框罩住 | 移除 `rt-agent-card__icon` 的底色方框 |
| 标题与来源、Wiki 入口与标签等语义混淆 | 来源使用引用、关联使用链节；问答与 Wiki 全链路分别统一气泡和书本 |
| 收藏、禁止、下载、设置等错误产品语义 | 改为入库、未展示、本地导入、内容构建等匹配图形 |
| 厂商 logo 顶替 Agent 产品 logo | Codex、DSH、Hermes、Qwen Code 改用各自产品级官方资源 |
| 深色主题隐藏无变体 logo | 仅在存在 `.agent-icon--dark` 时隐藏对应浅色图 |
| 跟随系统的深色模式未切换 Agent 资源 | 同时覆盖显式深色主题与系统深色媒体查询 |
| squash 时误删题卡国际化文案 | 恢复 `quiz.yourAnswer` 中英文条目，并由题卡 E2E 回归验证 |
| 未使用资源与重复品牌 URL | 清理无用图形、导入和旧 DeepSeek 资源；悬浮对话按钮复用 `BrandLogo` |

## 8. 验证与交付

- 所有前后对比图使用同一 main 基线、同一合成演示库、同一浏览器视口、同一截图脚本与相同操作步骤。
- 截图覆盖文档属性、会话标签、品牌、文件树、知识库全景、技能空态、保存入库、未展示来源、导入引导和 Agent 产品标识。
- 红框编号前后同义、同数量；截图使用合成数据，不包含真实用户知识库。
- `pnpm --filter @molio/web typecheck` 通过。
- `pnpm --filter @molio/web test` 通过（715 项）。
- `quiz.spec.ts` 与 `runtimes-page.spec.ts` 定向 E2E 通过（42 项），覆盖题卡文案回归与默认「跟随系统」的 Agent 深色资源切换。
- 全量 E2E 尚未取得全绿结果，合并前仍需在稳定环境完成全量验证；不得用定向测试或既有基线对照替代该门禁。
- 本文是仓库内唯一过程与交付文档，整合原现状清单、改造方案、最终实现、审查记录和验收结果。
