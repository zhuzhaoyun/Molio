# docs/ 目录索引

> 根目录放**活跃文档**（按 `YYYY-MM-DD-主题.md` 命名）；已交付功能的设计与实现计划移入 [archive/](archive/)；短期工作区在子目录。
> 惯例：设计/计划类文档保持**本地不提交**（见根 CLAUDE.md）；行为说明、基础设施指南与本索引进 git。归档/删除走 PR。

## 活跃规划（学习闭环 / 检索 / 体验）

| 文档 | 状态 |
|---|---|
| [2026-10-24-large-vault-performance-plan.md](2026-10-24-large-vault-performance-plan.md) | 大库性能（外部盘 7 万文件）；已合并 4 个 PR，下一步 worker 线程 |
| [2026-10-27-embedding-phase3-feasibility.md](2026-10-27-embedding-phase3-feasibility.md) | 三期本地 embedding 成本可行性；未拍板（三期前文案不得写语义检索） |
| [2026-10-26-kb-qa-autojudge-design.md](2026-10-26-kb-qa-autojudge-design.md) | KB 问答自动判断；A+B 已实施（#374/#375），C/D 待拍板 |
| [2026-10-24-skill-import-preview-dragdrop.md](2026-10-24-skill-import-preview-dragdrop.md) | skill 导入；P1 已合并（#372），P2 浏览器上传未开工 |
| [2026-10-24-quiz-subjective-answer-p2.md](2026-10-24-quiz-subjective-answer-p2.md) | quiz 主观题 P2（#378 已验收）；批改回写题卡已立项 |
| [2026-10-24-quiz-fill-input-domains.md](2026-10-24-quiz-fill-input-domains.md) | quiz 填空跨领域输入方案（拍板记录，理工科优先） |
| [2026-10-18-quiz-practice-design.md](2026-10-18-quiz-practice-design.md) | 出题/答题一期设计（已合并 a7ee7f63），二期参照 |
| [2026-10-22-rule-sandbox-p1-design-and-implementation.md](2026-10-22-rule-sandbox-p1-design-and-implementation.md) | rule-sandbox 一期（#346/#355 已合并）；P2 依据 |
| [2026-10-19-interactive-content-research.md](2026-10-19-interactive-content-research.md) | 交互式解释：声明式交互块路线（排在 quiz 之后） |
| [2026-10-23-office-document-ingestion-and-export.md](2026-10-23-office-document-ingestion-and-export.md) | 办公文档 P1 摄取（已做）+ P2 导出 docx；渲染预览不做 |
| [2026-10-19-onboarding-activation-design.md](2026-10-19-onboarding-activation-design.md) | 新手引导（#344 已实现）；后续 P0/P1/P2 已定义 |
| [2026-10-27-voice-input-research.md](2026-10-27-voice-input-research.md) | 语音输入调研；未排期（短口令 vs 长口述待拍板） |
| [2026-10-29-wechat-publish-image-hosting.md](2026-10-29-wechat-publish-image-hosting.md) | 公众号发布图片公网化（P1 待办，发布链路人人会撞） |

## 战略 / 调研池（选题池，立项时按条拆）

| 文档 | 主题 |
|---|---|
| [2026-10-10-molio-differentiation-directions.md](2026-10-10-molio-differentiation-directions.md) | 与 Obsidian 的结构性差异化，五方向选题池 |
| [2026-10-23-molio-moat-analysis.md](2026-10-23-molio-moat-analysis.md) | 护城河分析：死库→活库循环，证伪三信号 |
| [2026-10-10-retrieval-p0.md](2026-10-10-retrieval-p0.md) | 检索 P0 立项依据（一期/二期第一步已合并并验收） |
| [2026-09-30-agent-desktop-competitive-landscape.md](2026-09-30-agent-desktop-competitive-landscape.md) | 桌面 Agent 竞争格局；差异化=资产而非任务 |
| [2026-10-04-home-page-redesign-research.md](2026-10-04-home-page-redesign-research.md) | 主页改造调研（L2 系列上游，§10–12 补记） |
| [2026-10-09-chat-as-fullscreen-panel.md](2026-10-09-chat-as-fullscreen-panel.md) | `/chat` 成为悬浮面板全屏态（L2a 已合，L2b #388 已合） |
| [2026-09-17-nowledge-mem-talk-borrowing.md](2026-09-17-nowledge-mem-talk-borrowing.md) | Nowledge Mem 分享借鉴（开场注入/出处/复盘卡） |

## 增长 / SEO / 落地页

| 文档 | 主题 |
|---|---|
| [2026-09-03-seo-strategy-resources.md](2026-09-03-seo-strategy-resources.md) | 全站 SEO 策略（百度主 + GEO） |
| [2026-09-06-backlink-plan-resources.md](2026-09-06-backlink-plan-resources.md) | 外链方案：传权重与卖货分套打，按 SKU 分人群 |
| [2026-09-01-llms-txt-dynamic-design.md](2026-09-01-llms-txt-dynamic-design.md) | llms.txt 动态化 + 资源重心重构 |
| [2026-09-01-ssr-product-pages-design.md](2026-09-01-ssr-product-pages-design.md) | 商品详情页 SSR 化（已接入生产） |
| [2026-09-16-indexnow-bing-submit.md](2026-09-16-indexnow-bing-submit.md) | IndexNow/Bing 主动推送 |
| [2026-10-26-resource-product-page-design.md](2026-10-26-resource-product-page-design.md) | 资源商品详情页：搜索意图承接（已接入发布链路） |

## 运营 / 验证流

| 文档 | 状态 |
|---|---|
| [2026-09-21-co-builder-campaign-plan.md](2026-09-21-co-builder-campaign-plan.md) | 用户群征集（已执行 + 复盘 §15） |
| [2026-10-18-survey-results.md](2026-10-18-survey-results.md) | 问卷首批 8 份结果分析（方向校准用） |
| [2026-09-11-fakao-kb-validation-plan.md](2026-09-11-fakao-kb-validation-plan.md) | 法考知识包 MVP 验证（刑诉定位卡 23 张全量完成） |
| [2026-08-17-yijing-kb-design.md](2026-08-17-yijing-kb-design.md) | 易经知识库（样章 7 卦全注，64 卦源已落袋） |
| [2026-09-08-cross-folder-kb-strategy.md](2026-09-08-cross-folder-kb-strategy.md) | 跨文件夹 KB 策略纪要（PR #255 进行中） |
| [2026-09-08-linked-source-roots-design.md](2026-09-08-linked-source-roots-design.md) | 链接素材根技术设计（同上，junction/symlink 方案） |
| [2026-09-08-wechat-article-notes.md](2026-09-08-wechat-article-notes.md) | 公众号文章想法（跨文件夹 vs Obsidian，待起草） |

## 行为说明（对应已合并 PR，改动相关模块前先读）

[desktop-windows-taskbar.md](desktop-windows-taskbar.md)（#261 任务栏身份）·
[2026-09-16-linkpass-cjk-guard-design.md](2026-09-16-linkpass-cjk-guard-design.md)（#258 链接对账）·
[2026-09-26-wiki-cjk-emphasis-design.md](2026-09-26-wiki-cjk-emphasis-design.md)（#271 CJK 加粗防护）·
[2026-09-27-daemon-flaky-tests-design.md](2026-09-27-daemon-flaky-tests-design.md)（#273 flaky 修复）·
[2026-09-27-kb-scroll-reset-design.md](2026-09-27-kb-scroll-reset-design.md)（#283 滚动重置）·
[2026-09-17-graph-destroy-white-screen-fix.md](2026-09-17-graph-destroy-white-screen-fix.md)（#260 图谱白屏）·
[2026-10-05-chat-h4-heading-render-design.md](2026-10-05-chat-h4-heading-render-design.md)（#295 h4 渲染）·
[2026-09-26-desktop-e2e-spec-revival-design.md](2026-09-26-desktop-e2e-spec-revival-design.md) ·
[2026-09-30-desktop-e2e-nightly-ci-design.md](2026-09-30-desktop-e2e-nightly-ci-design.md) ·
[2026-10-09-desktop-e2e-process-cleanup-design.md](2026-10-09-desktop-e2e-process-cleanup-design.md)（#325）·
[2026-09-30-electron-builder-mirror-fallback-design.md](2026-09-30-electron-builder-mirror-fallback-design.md) ·
[kb-chat-interrupt-queue.md](kb-chat-interrupt-queue.md)（中断/排队机制）

## 基础设施 / 长期参考

| 文档 | 主题 |
|---|---|
| [desktop-dev-guide.md](desktop-dev-guide.md) | 桌面开发环境构建与运行指南（活文档） |
| [user-module-design.md](user-module-design.md) | 云端认证服务设计（auth.molio.cn 已上线） |
| [hermes-agent-design.md](hermes-agent-design.md) | Hermes/ACP 运行时接入设计（runtime 在产品内） |
| [article-hermes-agent-integration.md](article-hermes-agent-integration.md) | Hermes 落地笔记（commits bff786c/4365cf7） |

## 子目录

| 目录 | 用途 | git |
|---|---|---|
| [archive/](archive/) | 已交付功能的设计与实现计划、已结案/搁置的方案、过时对比（30 篇） | 部分 |
| [kb-architecture/](kb-architecture/) | 知识库体系学习笔记（wiki 式自组织，从 [概述](kb-architecture/概述.md) 开始） | 不入库 |
| [superpowers/](superpowers/) | plans/specs 工作流产物 | 不入库 |
| [articles/](articles/) | 公众号文章工作区（草稿/证据/发布稿） | 不入库 |
| [2026-10-29-boundary-theory-deck/](2026-10-29-boundary-theory-deck/) | 投资人「能力边界理论」PPT 交付物 | 不入库 |
| [prototype/](prototype/) | 资源页设计原型（被代码注释引用，勿删） | 入库 |
| [img/](img/) | README 用图 | 入库 |
| [icon/](icon/) | 应用图标素材 | 入库 |

## archive/ 内容速览

- **已交付功能的设计/实现计划**：PDF 预览一二期 ×4、多窗口 ×2、前进后退导航历史、图谱进标签、单库分屏、局部焦点模式、图谱交互交接（Sigma→Pixi）、启动性能（#268）、主页演化 v1、wiki 入库状态、KB 拖拽导入、preload 清理与 Windows 复盘、skill 导入 P1 计划、onboarding 计划、quiz 一期进展、L2a 计划与会话梳理
- **已结案/搁置**：资源商业模式调研、明朝人脉图生成器（含复活条件）、楚汉学习图谱、小白用户事故复盘
- **过时对比**：Obsidian 功能对比 ×2 + 配图（2026-06 特性表，现行对比见 kb-architecture/comparisons/）
