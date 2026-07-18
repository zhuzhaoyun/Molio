# 可恢复的分层 Wiki Build 设计（一期）

日期：2026-07-18
状态：待用户复核
目标分支：`codex/wiki-build-scalable`

## 1. 背景

Molio 当前沿用 llm-wiki 的 Markdown 工作流。`wiki-build` 是纯提示词 Skill：Agent 扫描 vault 的全部源文件，规划页面，写入 `wiki/`，再维护单个 `INDEX.md`。Wiki query 先读取 `hot.md` 和完整 `INDEX.md`，再由 Agent 打开相关页面。

这个方案适合数百个小文件。大库会遇到以下问题：

- Agent 在规划前自行遍历和读取全库，首次构建无法控制输入量。
- Skill 没有稳定的 manifest、批次状态和断点恢复协议。
- 单个全局 `INDEX.md` 会随页面数量增长，query 每次加载它会浪费上下文。
- Wiki query 仍依赖 Markdown INDEX 导航；全文索引和相关性排序留到二期。

`D:\work\articles-1` 是本设计的首个大库样本。它尚未构建 Wiki，当前包含 643 个原始文件、约 824 MB 数据，包括 242 MB JSON、94 MB PPTX 和 7.8 MB Markdown。它代表“首次构建风险”，不是已有 Wiki 的查询故障样本。

## 2. 设计目标

- 用户手动触发 wiki-build。
- 系统先做元数据清点和轻量采样，生成构建计划；用户批准前不写 Wiki。
- Wiki 主题最多两级。构建计划可使用一级或两级主题，任务按 token 预算继续拆批。
- 构建支持中断、恢复、跳过、重试和单文件失败隔离。
- 保留 llm-wiki 的持续编译、交叉链接、来源追踪和知识写回能力。
- 叶主题 INDEX 完整列出全部 Wiki 页面，供浏览、审计和一期查询使用。
- 首版使用 `D:\work\articles-1` 做端到端验收，以扫描时的真实文件集合和数据规模为准。

## 3. 非目标

- 首版不实现 FTS5、BM25、向量检索、Wiki 搜索 API 或 runtime 到 daemon 的搜索回调。
- 首版不自动移动、重命名或修改用户的原始文件。
- 首版不自动重构已有的扁平 Wiki。
- 首版不承诺解析 ZIP、RAR、IFC 或任意超大结构化文件。
- 首版不让多个 Agent 并发修改同一个叶主题。

## 4. 用户流程

### 4.1 预扫描与计划

1. 用户点击“构建 Wiki”。
2. `wiki-build` Skill 调用确定性扫描工具。
3. 扫描工具生成源文件 inventory，不创建 Wiki 页面。
4. Agent 根据 inventory、目录名称、标题和轻量采样提出一级或两级主题及构建批次。
5. Agent 在对话中展示主题、文件归属、排除项、风险和预计工作量。
6. 用户要求修改或批准计划。
7. Skill 冻结获批计划的版本，并开始执行。

扫描期间新增的文件不进入已经冻结的计划。后续 wiki-ingest 处理这些文件。

### 4.2 执行与恢复

Skill 按叶主题执行构建。叶主题可以是一级主题，也可以是二级主题。同一主题中的批次按顺序运行；不同主题在首版也串行执行。每个批次完成后，工具写入文件级和批次级检查点。

用户取消或 Agent 退出后，下次触发 wiki-build 时，Skill 读取获批计划和检查点，展示剩余工作并请求继续。它不会重建已经成功且源文件指纹未变化的批次。

## 5. Wiki 目录约束与参考结构

下面的目录树只说明层级关系，不是固定模板。`topics/` 不作为额外目录，一级主题直接位于 `wiki/` 下。

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

固定约束：

- `wiki/INDEX.md` 只列一级主题及短摘要。
- 一级主题需要拆分时，它的 `INDEX.md` 只列二级主题及短摘要；无需拆分时，它本身就是叶主题。
- 叶主题的 `INDEX.md` 按页面类型列出该主题的全部 Wiki 页面，每页包含链接和一句话摘要。
- `log.md`、`hot.md`、`meta` 和 `INDEX.md` 是根目录保留名称。

构建计划决定以下内容：

- 一级、二级主题的名称和数量。
- 是否需要二级主题。系统不为内容集中的知识库强制创建空层级。
- 叶主题下使用哪些页面类型目录。`sources`、`entities`、`concepts`、`comparisons`、`questions` 和其他类型按内容需要创建，不要求每个主题具有相同目录。

原始目录名称只作为分类信号。`raw`、`Clippings` 和 `项目文件` 这类来源目录不会自动成为知识主题。每个源文件拥有一个主叶主题，并可通过 related topics 关联其他主题；系统不移动原始文件。

## 6. wiki-build Skill 的职责

### 6.1 当前 daemon 与 runtime 的关系

Molio 当前使用 daemon 作为宿主和控制面：

```text
Web
→ daemon API
→ RunManager
→ runtime agent CLI 子进程
→ vault 文件系统和已安装 Skill

runtime stdout/stderr
→ RunManager
→ SSE
→ Web
```

daemon 把内置 Skill 安装到 vault 的 `.claude/skills/`，选择 Claude、Codex、Qwen、Gemini 或 Hermes runtime，设置 vault cwd，然后启动 Agent CLI 子进程。runtime agent 读取 Skill、操作文件并输出事件。daemon 负责进程生命周期、消息持久化、取消、多轮输入和事件转发。当前 runtime agent 不以调用 daemon API 作为常规执行路径。

### 6.2 wiki-build 升级

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

扫描和状态脚本使用 Node.js 标准库，随 Skill 一起安装。runtime agent 在 vault cwd 中调用这些脚本并读写 `.molio/wiki-build/`。一期不新增 daemon API，也不改变 daemon 启动和管理 runtime 的方向。

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
- 一级或两级主题树及主题说明。
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

每个批次先创建或更新 source 页面，再更新该主题的实体、概念和对比页面。二级主题完成后生成主题摘要；包含二级主题的一级主题只读取这些摘要进行汇总。没有二级主题时，一级主题直接汇总自己的叶页面。全局 `INDEX.md` 只读取一级主题摘要。

## 9. 一期 Wiki Query

一期保留 llm-wiki 的分层 INDEX 导航，不新增检索基础设施：

```text
用户问题
→ 读取 hot.md（存在时）
→ 读取 wiki/INDEX.md
→ 读取候选一级主题 INDEX
→ 读取候选叶主题 INDEX
→ 打开相关 Wiki 页面和关联页面
→ Wiki 信息不足时沿 sources 回溯原始文件
→ 生成回答
→ 用户确认后通过 wiki-save 写回长期价值结论
```

Agent 优先使用编译后的 Wiki 页面，信息不足时才读取原始文件。完整的叶主题 INDEX 负责页面目录和覆盖率。大型 Wiki 的全文检索与排名问题由二期 FTS/BM25 解决。

## 10. wiki-ingest

wiki-ingest 复用相同 manifest 和主题路由：

1. 扫描目标文件并计算内容哈希。
2. 根据全局、一级和叶主题 INDEX 提出主主题。
3. 用户需要时可调整主题归属。
4. Skill 更新 source 页面及相关知识页面。
5. Skill 更新叶主题和一级主题 INDEX。

## 11. 兼容与迁移

已有扁平 Wiki 保持可读、可查，不自动移动文件。系统通过目录结构或 schema 标记识别 legacy Wiki：

- legacy query 继续使用现有 `hot.md`、`INDEX.md` 和页面读取流程。
- 用户显式执行“按主题重建”后，wiki-build 才生成新的主题结构。
- 系统在重建前生成计划和冲突报告，不覆盖无法映射的用户页面。

## 12. 错误处理

- 扫描错误记录到 inventory，扫描继续执行。
- 预处理器失败只标记对应文件，并保留可复制的错误信息。
- 页面写入使用临时文件加原子替换，避免半页内容。
- checkpoint 写入失败时，Skill 不领取下一个批次。
- 构建完成条件由工具检查：获批计划没有 pending/running 批次，叶主题 INDEX 覆盖全部页面，source 页面存在。

## 13. 测试与验收

### 13.1 单元测试

- 扫描过滤、目录上限、总文件上限和轻量采样。
- 指纹、计划冻结、批次预算和状态转换。
- 中断恢复、失败隔离和幂等 checkpoint。
- 最多两级的主题路径和保留名称校验。
- 叶主题 INDEX 覆盖全部页面，且没有重复项、缺失项或死链。

### 13.2 集成测试

- 从扫描到计划审批，再到两级 Wiki 输出的完整流程。
- 构建中途终止后从最后 checkpoint 恢复。
- ingest 单文件后只更新受影响页面和分层 INDEX。
- query 通过分层 INDEX 命中 Wiki，缺口场景再回溯源文件。
- legacy Wiki 无迁移查询。

### 13.3 容量验收

- 使用 `D:\work\articles-1` 的扫描时快照执行验收，不把固定文件数量写死为产品承诺。
- 预扫描覆盖全部可见文件；每个文件进入构建计划、排除列表或待用户决定列表，三者数量之和与 inventory 一致。
- 获批计划可完成端到端构建；构建队列可跨进程恢复，已完成批次不重复执行。
- 大型 JSON、Markdown、PPTX、DOCX、PDF 和不支持格式按计划处理，单文件失败不阻塞其他批次。
- 构建完成后使用该库的代表性问题验证分层 INDEX 导航、Wiki-first 回答和来源回溯。
- `MAX_TOTAL=50000` 继续作为扫描安全上限，不代表首版容量承诺。

## 14. 二期：Wiki FTS5/BM25

二期单独设计和实现 Wiki 全文索引。候选范围包括全 Wiki Markdown 入库策略、章节切分、BM25 排名、增量同步、daemon API 和 runtime 搜索工具。一期不创建相关表、接口或占位代码。

## 15. 实施边界

一期涉及以下代码边界：

- `wiki-build`/`wiki-ingest` Skill 及其纯 Node 辅助脚本。
- Skill 安装与测试，确保辅助脚本随内置 Skill 复制到 vault。
- 现有聊天交互中的计划审批和构建进度，不新增专用 daemon API。

实施计划先完成 inventory、计划冻结、批次状态和恢复脚本，再升级 wiki-build/wiki-ingest 流程，最后使用 `D:\work\articles-1` 验收。每个阶段保持 legacy Wiki 可用。
