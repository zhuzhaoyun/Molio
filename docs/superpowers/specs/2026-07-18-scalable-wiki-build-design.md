# 可扩展 Wiki Build 与 Wiki-first 检索设计

日期：2026-07-18
状态：待用户复核
目标分支：`codex/wiki-build-scalable`

## 1. 背景

Molio 当前沿用 llm-wiki 的 Markdown 工作流。`wiki-build` 是纯提示词 Skill：Agent 扫描 vault 的全部源文件，规划页面，写入 `wiki/`，再维护单个 `INDEX.md`。Wiki query 先读取 `hot.md` 和完整 `INDEX.md`，再由 Agent 打开相关页面。

这个方案适合数百个小文件。大库会遇到四类问题：

- Agent 在规划前自行遍历和读取全库，首次构建无法控制输入量。
- Skill 没有稳定的 manifest、批次状态和断点恢复协议。
- 单个全局 `INDEX.md` 会随页面数量增长，query 每次加载它会浪费上下文。
- 知识库 UI 搜索仍使用同步目录遍历和 `indexOf`；Wiki query 没有全文索引或相关性排序。

`D:\work\articles-1` 是本设计的首个大库样本。它尚未构建 Wiki，当前包含 643 个原始文件、约 824 MB 数据，包括 242 MB JSON、94 MB PPTX 和 7.8 MB Markdown。它代表“首次构建风险”，不是已有 Wiki 的查询故障样本。

## 2. 设计目标

- 用户手动触发 wiki-build。
- 系统先做元数据清点和轻量采样，生成构建计划；用户批准前不写 Wiki。
- Wiki 固定使用两级主题，构建任务按 token 预算继续拆批。
- 构建支持中断、恢复、跳过、重试和单文件失败隔离。
- query 优先检索编译后的 Wiki 页面，信息不足时才回溯原始文件。
- 采用页面感知的 FTS5/BM25 检索，避免 query 加载完整页面目录。
- 保留 llm-wiki 的持续编译、交叉链接、来源追踪和知识写回能力。
- 首版以单 vault 10,000 个源文件为验收目标，50,000 个作为扩展压测目标。

## 3. 非目标

- 首版不引入向量数据库或外部搜索服务。
- 首版不自动移动、重命名或修改用户的原始文件。
- 首版不自动重构已有的扁平 Wiki。
- 首版不承诺解析 ZIP、RAR、IFC 或任意超大结构化文件。
- 首版不让多个 Agent 并发修改同一个二级主题。

## 4. 用户流程

### 4.1 预扫描与计划

1. 用户点击“构建 Wiki”。
2. `wiki-build` Skill 调用确定性扫描工具。
3. 扫描工具生成源文件 inventory，不创建 Wiki 页面。
4. Agent 根据 inventory、目录名称、标题和轻量采样提出两级主题及构建批次。
5. Agent 在对话中展示主题、文件归属、排除项、风险和预计工作量。
6. 用户要求修改或批准计划。
7. Skill 冻结获批计划的版本，并开始执行。

扫描期间新增的文件不进入已经冻结的计划。后续 wiki-ingest 处理这些文件。

### 4.2 执行与恢复

Skill 按二级主题执行构建。同一主题中的批次按顺序运行；不同主题在首版也串行执行。每个批次完成后，工具写入文件级和批次级检查点。

用户取消或 Agent 退出后，下次触发 wiki-build 时，Skill 读取获批计划和检查点，展示剩余工作并请求继续。它不会重建已经成功且源文件指纹未变化的批次。

## 5. Wiki 目录结构

`topics/` 不作为额外目录。一级主题直接位于 `wiki/` 下。

```text
wiki/
├── INDEX.md
├── log.md
├── hot.md
├── meta/
├── 建筑工程/
│   ├── INDEX.md
│   ├── 规范审查/
│   │   ├── INDEX.md
│   │   ├── sources/
│   │   ├── entities/
│   │   ├── concepts/
│   │   └── comparisons/
│   └── BIM协同/
└── 企业数字化/
    ├── INDEX.md
    ├── 信息化建设/
    └── 网络安全与算力/
```

目录语义：

- `wiki/INDEX.md` 只列一级主题及短摘要。
- 一级主题的 `INDEX.md` 只列二级主题及短摘要。
- 二级主题的 `INDEX.md` 提供精选导航，不要求列出该主题的全部页面。
- `sources`、`entities`、`concepts` 和 `comparisons` 只出现在二级主题内。
- `log.md`、`hot.md`、`meta` 和 `INDEX.md` 是根目录保留名称。

原始目录名称只作为分类信号。`raw`、`Clippings` 和 `项目文件` 这类来源目录不会自动成为知识主题。每个源文件拥有一个主二级主题，并可通过 related topics 关联其他主题；系统不移动原始文件。

## 6. wiki-build Skill 的职责

`wiki-build` 仍是用户和 Agent 的唯一构建入口。Skill 从纯提示词工作流升级为“工作流说明 + 确定性辅助工具”。

```text
wiki-build Skill
├── scan      生成 inventory
├── plan      保存和校验计划
├── status    读取构建状态
├── next      领取下一个批次
├── checkpoint 写入批次结果
└── finalize  汇总主题索引并完成构建
```

Skill 负责：

- 规定扫描、审批、执行、恢复和完成条件。
- 指导 Agent 生成主题规划和 Wiki 页面。
- 在用户批准前停止执行。
- 调用工具领取有限大小的批次。
- 在批次结束后提交结构化状态。

辅助工具负责：

- 文件遍历、过滤、指纹和轻量采样。
- manifest、计划版本、批次队列和状态机。
- 原子写入、恢复校验和最终完整性检查。
- 请求 daemon 更新 Wiki FTS 索引。

扫描和状态脚本使用 Node.js 标准库，随 Skill 一起安装。FTS5 由 daemon 管理，因为 Molio 已在 daemon 中使用 `better-sqlite3` 和 FTS5，且 query、ingest、文件监听都需要共享索引。

## 7. 构建状态与文件

构建过程文件存放在 vault 的 `.molio/wiki-build/`，知识库树和 watcher 会忽略该目录。

```text
.molio/wiki-build/
├── inventory.jsonl
├── plan.json
├── state.json
├── samples/
└── normalized/
```

### 7.1 inventory

每条源文件记录至少包含：

- 相对路径、扩展名、大小和修改时间。
- 快速指纹；正式处理时再计算内容哈希。
- 检测到的标题、编码和轻量采样路径。
- 预处理器类型和支持状态。
- 重复文件候选和风险标记。

扫描不会全文读取大型文本，也不会解析 Office、PDF 或压缩包内容。

### 7.2 plan

获批计划至少包含：

- `planVersion`、创建时间和批准状态。
- 一级主题、二级主题和主题说明。
- 文件主主题、关联主题及预处理方式。
- 批次顺序和每批 token 预算。
- 排除文件、待用户决定的文件和原因。

批准后，工具拒绝原地修改计划。用户需要修改时，Agent 创建新版本并重新请求批准。

### 7.3 state

文件和批次使用以下状态：

```text
pending → running → succeeded
                  ↘ failed
pending → skipped
```

`running` 状态在进程异常退出后可恢复为 `pending`。工具记录重试次数和最近错误。单文件失败不会终止其他批次。

## 8. 批次与大文件处理

工具同时按文件数量和 token 预算拆批：

- 普通批次包含约 10 至 50 个文件。
- 输入预算不得超过当前模型上下文的 20% 至 30%。
- 超长 Markdown/TXT 按标题切分；缺少标题时按字符窗口切分并保留重叠。
- PDF、PPTX 和 DOCX 先标准化为 Markdown，再进入普通批次。
- 大型 JSON 使用流式结构摘要、JSONL 分片或用户指定的字段提取策略。
- ZIP、RAR、IFC 和未知格式进入待确认列表，不阻塞其余构建。

每个批次先创建或更新 source 页面，再更新该主题的实体、概念和对比页面。二级主题完成后生成主题摘要；一级主题完成后只读取其二级主题摘要进行汇总。全局 `INDEX.md` 只读取一级主题摘要。

## 9. Wiki FTS5/BM25

### 9.1 当前实现

Molio 已为会话历史实现 `messages_fts`，包含 trigram tokenizer、同步触发器、一次性回填和重建函数。Wiki 尚未使用这套索引。知识库 UI 的 `searchFiles` 每次同步遍历文本文件并执行 `indexOf`，不提供分词、相关性评分或 Wiki query 集成。

### 9.2 新索引

daemon 在现有 SQLite 数据库中新增独立的 Wiki 表，按 `vault_id` 隔离：

- `wiki_pages`：页面路径、标题、页面类型、一级主题、二级主题、frontmatter、内容哈希和更新时间。
- `wiki_sections`：页面内章节、顺序、正文和来源映射。
- `wiki_sections_fts`：使用 FTS5 trigram tokenizer 的章节全文索引。

索引以章节作为召回单位，以页面作为上下文单位。查询先对章节执行 BM25，再按页面聚合。标题、标签和章节标题拥有高于正文的权重。

daemon 通过以下路径维护索引：

- wiki-build 和 wiki-ingest 成功写页后显式增量更新。
- vault watcher 发现外部修改后按页面重新索引。
- daemon 提供按 vault 重建 Wiki 索引的维护操作。
- 删除页面或 vault 时同步删除对应索引行。

## 10. Wiki-first Query

query 使用以下顺序：

```text
用户问题
→ 全局主题路由
→ 一级主题
→ 二级主题
→ FTS5/BM25 召回 Wiki 章节
→ 按 Wiki 页面聚合和重排
→ 加载 frontmatter、命中章节和关联页面
→ Wiki 信息不足时沿 sources 回溯原始文件
→ 生成回答
→ 用户确认后通过 wiki-save 写回长期价值结论
```

FTS 章节只负责召回。Agent 使用 Wiki 页面及其关系作为推理上下文。原始文件保留证据层角色。系统不会默认直接从原始 chunk 生成答案。

query 结果必须保留页面路径、章节、主题和来源映射，供 Agent 生成 wikilink 与来源说明。

## 11. wiki-ingest

wiki-ingest 复用相同 manifest、主题路由和索引接口：

1. 扫描目标文件并计算内容哈希。
2. 根据已存在的主题摘要和 FTS 候选页提出主主题。
3. 用户需要时可调整主题归属。
4. Skill 更新 source 页面及相关知识页面。
5. daemon 增量更新受影响的 Wiki 章节索引。
6. Skill 更新二级和一级主题摘要，不重读全局页面目录。

## 12. 兼容与迁移

已有扁平 Wiki 保持可读、可查，不自动移动文件。系统通过目录结构或 schema 标记识别 legacy Wiki：

- legacy query 继续使用现有 `hot.md`、`INDEX.md` 和页面读取流程。
- daemon 可以为 legacy Wiki 建立 FTS 索引，改善查询性能，不改变其目录。
- 用户显式执行“按主题重建”后，wiki-build 才生成新的两级主题结构。
- 系统在重建前生成计划和冲突报告，不覆盖无法映射的用户页面。

## 13. 错误处理

- 扫描错误记录到 inventory，扫描继续执行。
- 预处理器失败只标记对应文件，并保留可复制的错误信息。
- 页面写入使用临时文件加原子替换，避免半页内容。
- checkpoint 写入失败时，Skill 不领取下一个批次。
- FTS 更新失败不回滚已经写好的 Markdown；系统标记索引 stale 并允许重建。
- 构建完成条件由工具检查：获批计划没有 pending/running 批次，主题 INDEX 完整，source 页面存在，FTS 索引版本匹配。

## 14. 测试与验收

### 14.1 单元测试

- 扫描过滤、目录上限、总文件上限和轻量采样。
- 指纹、计划冻结、批次预算和状态转换。
- 中断恢复、失败隔离和幂等 checkpoint。
- 两级主题路径和保留名称校验。
- FTS 建表、回填、触发同步、删除同步和重建。
- 中文 trigram 检索、BM25 排序、主题过滤和页面聚合。

### 14.2 集成测试

- 从扫描到计划审批，再到两级 Wiki 输出的完整流程。
- 构建中途终止后从最后 checkpoint 恢复。
- ingest 单文件后只更新受影响页面和索引。
- Wiki-first query 命中 Wiki，缺口场景再回溯源文件。
- legacy Wiki 无迁移查询。

### 14.3 容量验收

- 10,000 个源文件可完成预扫描并生成计划。
- 构建队列可跨进程恢复，已完成批次不重复执行。
- FTS query 不遍历 vault 文件系统，返回时间不随源文件总数线性增长。
- 50,000 个文件执行扫描和索引专项压测，但首版不把它列入正式支持承诺。

## 15. 实施边界

本设计涉及三个代码边界：

- `wiki-build`/`wiki-ingest` Skill 及其纯 Node 辅助脚本。
- daemon 的构建计划、状态和 Wiki FTS 服务及 API。
- Web 的计划审批、进度和失败展示。

实施计划应拆成可独立验证的阶段：先完成 manifest 与 FTS 基础，再升级 Skill 工作流，最后接入审批和进度 UI。每个阶段保持 legacy Wiki 可用。
