---
name: wiki-build
description: 构建/重建本地知识库的 Wiki。扫描 vault 中所有源文件，从中构建一个结构化的 wiki（源文件摘要、实体、概念、对比、概述页），创建分层 INDEX（根索引 + 各目录索引）/log/hot，密集交叉链接。支持超长源文件（百万字级小说等）：prep.mjs 确定性预处理 + 分层 digest 构建 + 断点续传。也能把旧单索引库的索引重构为分层布局。Triggers on: 构建 wiki, 重建 wiki, build wiki, 扫描源文件构建, 初始构建, 重新构建知识库, start wiki build, 重构索引, 索引分层, 索引迁移, restructure index.
version: 1.6.0
---

# wiki-build: 构建 Wiki

wiki 不是一次性的输出，而是一个持续增长的复利资产 — 每次构建、导入、查询都会让它更丰富。

> **维护注记**：wiki-* 五件套（build/query/ingest/save/lint）同版本号共进——改任一 skill 时，五个 `version:` 一起 bump 到同一下一个版本。

## 核心原则

- **源文件不可变**：源文件（notes/、docs/ 等）是用户的原始资料，只能读取，绝对不能修改或删除。
- **密集交叉链接**：[[wiki 链接]] 是这个知识库的核心价值。每个页面都应大量链接到其他相关页面，形成知识网络。宁可多链接，不要少链接。
- **合成而非搬运**：wiki 不是源文件的简单摘要集合，而是要提炼出跨源文件的综合观点、论点和洞察。
- **结构化元数据**：每个页面必须带完整的 frontmatter，这是知识网络可查询、可审计的基础。

## Vault 结构

vault 根目录就是当前工作目录。源文件在子目录中（如 raw/、notes/、docs/）。
wiki 相关内容的目录结构：
- `raw/` — 未处理的原始资料目录
- `raw/wechat/` — 微信通道收到的网页、文件等原始资料统一先放在这里
- `wiki/` — 所有 wiki 页面的根目录
- `wiki/INDEX.md` — 根索引，只列目录级概览（各目录页数 + 覆盖范围）与概述入口页，不逐页罗列
- `wiki/<dir>/INDEX.md` — 每个内容目录（sources/entities/concepts/comparisons/questions）自己的索引，列全该目录页面及一句话摘要
- `wiki/log.md` — 按时间顺序记录的操作日志（最新条目在最上面）
- `wiki/hot.md` — 近期上下文缓存（~500 字，每次操作后刷新）
- `wiki/meta/` — 元数据目录（lint 报告等）
- `wiki/sources/` — 源文件摘要页，由 raw/、notes/、docs/ 等原始资料生成；不要把原始资料直接放入这里
- `wiki/entities/` — 人物、组织、工具等实体页
- `wiki/concepts/` — 概念、模式、框架等
- `wiki/comparisons/` — 对比分析页
- `wiki/questions/` — 归档的问答页

构建超长源文件时，确定性过程文件统一放 `.molio/wiki-build/`（文件树扫描会跳过 `.molio`，不污染 vault；跨会话可续传）。

页面路径规则：
- 默认使用单文件页面。**文件名 = 实体/概念的规范名本身**：中文内容用中文名直做文件名（如 `wiki/entities/李白.md`），英文内容用 kebab-case（如 `wiki/entities/molio.md`）。`[[wiki 链接]]` 的链接名必须与目标文件名（去掉 `.md`）完全一致——`[[李白]]` 对应 `李白.md`，写成 `libai.md` 会断链
- 只有当某个实体、项目或主题需要拆成多个稳定页面时，才建立同名目录，并用 `index.md` 作为该目录入口
- 同名目录下的子页面必须围绕该入口主题展开，例如 `wiki/entities/molio/index.md`、`wiki/entities/molio/architecture.md`
- 不要把项目命名空间强行放进错误的内容类型目录；目录首先按页面类型归类，再按主题自然生长

## Frontmatter 规范

每个 wiki 页面必须包含以下 YAML frontmatter：

```yaml
---
type: source | entity | concept | comparison | overview | question | session
title: "人类可读的标题"
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - 领域标签
related:
  - "[[相关页面]]"
sources:
  - "[[源文件名]]"
---
```

字段说明：
- `type`：页面类型，必须是以上值之一
- `title`：人类可读标题
- `created` / `updated`：创建和最后更新日期
- `tags`：领域标签列表（至少一个）
- `related`：相关页面的 [[wiki 链接]] 列表（尽量多填）
- `sources`：信息来源的 [[wiki 链接]] 列表（source 类型页面填原始文件名，其他类型填参考了哪些 source 页面）

## 页面类型说明

根据源文件的内容、规模和领域，自行决定最合适的页面类型。以下是参考：
- **source**（源文件摘要）— 每个源文件一个摘要页，提取关键信息，放在 `wiki/sources/`
- **entity**（实体）— 人物、组织、工具等命名实体，放在 `wiki/entities/`
- **concept**（概念）— 关键概念、想法、模式、框架，放在 `wiki/concepts/`
- **comparison**（对比）— 相关概念或方法之间的对比分析，放在 `wiki/comparisons/`
- **overview**（概述）— 当源文件较多（≥5 篇）且跨多个主题时创建，提炼跨源文件的核心论点

目录结构应从内容中自然生长，不要强行套用固定模板。如果源文件只有几篇且主题集中，扁平结构就够用。

## 建页粒度

哪些实体独立建页、哪些收纳进概念页，按**内容能否支撑独立页面**判断（不靠频率百分比或绝对次数——不同长度/领域的源文件频率分布差异大，阈值会失真）：

应建独立页（任一满足）：
- 出现在章节标题/目录中（强信号，必有内容可写）
- 能用 `grep -nF 名字` 取到足够上下文写出有实质内容的独立描述（首次出现 + 身份归属 + 至少一个关键事件/关系）

只有零星提及（如"某某点头""某某路过"，grep 取证写不出实质内容）→ 放概念页表格行，不独立建页。

不同源文件的粒度不同，按各自内容特征独立判断。census 频率是排序信号，不是建页阈值。

## 索引分层结构（根 INDEX + 各目录 INDEX）

索引固定分两层：**根 INDEX 只给目录级概览**（与页面总数解耦，始终几十行），**每个内容目录有自己的 INDEX.md 列全该目录页面**。检索层层递进：根 INDEX → 相关目录 INDEX → 页面。根索引若逐页罗列，页面一多就会长到 runtime 一次读不完（Read 上限 2000 行），整个问答链路随之失效——这是分层的原因，不要因为"库还小"而退回单索引。

**根 `wiki/INDEX.md`** 格式：

```markdown
# Wiki 索引

> 一句话全库概述 + 页面总数构成（源摘要 N · 实体 N · 概念 N · 对比 N …）

## 概述
- [[概述页]] — 一句话摘要（入口页，直接内联列出）

## 目录
- [[sources/INDEX|源文件摘要]]（N 页）— 覆盖主题一句话概览 + 2-3 个代表条目名
- [[entities/INDEX|实体]]（N 页）— 人物/组织/工具；代表条目名
- [[concepts/INDEX|概念]]（N 页）— 覆盖领域；代表条目名
- [[comparisons/INDEX|对比分析]]（N 页）— 有哪些对比
- [[questions/INDEX|归档问答]]（N 页）— …（有页面时才列）
```

**各目录 `wiki/<dir>/INDEX.md`**（sources / entities / concepts / comparisons / questions）格式：

```markdown
# <分类名>索引

- [[页面]] — 一句话摘要
```

规则：
- 概述页（通常 1-2 篇、全库入口）直接在根 INDEX 内联，不为 overview/ 单建目录索引
- `meta/` 是元数据目录（lint 报告等），不建索引、不列入根 INDEX
- 目录 INDEX 列全该目录页面（wikilink + 一句话摘要）；条目多时用 `##` 子标题分组（sources 按主题、entities 按人物/组织/工具、concepts 按领域）
- 目录索引统一大写 `INDEX.md`，与多页主题目录的小写 `index.md` 入口页区分
- 单目录索引几百行 Read 一次可读完，不做二次分片

## 索引分层迁移（已有 wiki）

存量库若是旧单索引布局（根 INDEX.md 直接以 `- [[页面]] — 摘要` 逐页罗列、内容目录无 INDEX.md），**不重建页面**、只重构索引：

1. `find wiki/ -name '*.md'` 一次，建「页名 → 所在目录」映射
2. 读旧根 INDEX.md，每条页面条目按映射分流写入对应目录的 INDEX.md（保留原摘要；条目多则 `##` 分组）
3. 根 INDEX.md 按上节分层格式改写（概述条目内联，其余目录各一行：目录链接 + 页数 + 覆盖范围）
4. log.md 记一条 `index | 索引分层迁移`

触发：用户说「重构索引 / 索引分层 / 索引迁移」。过程幂等——目录索引已存在即跳过。wiki-ingest / wiki-save 在旧布局库上首次触发时也会自动执行本流程（见各自 SKILL.md）。

## wiki/log.md 格式

最新条目在最上面：
```markdown
# 构建日志

## YYYY-MM-DD HH:MM | build | 初始构建
- 扫描源文件数：N
- 创建页面数：N（按类型列出）
- 关键发现：一句话概述
```

## 超长源文件处理（prep.mjs 预处理 + 分层构建）

源文件若无法在一次上下文内通读（通读后还要留空间规划+生成+交叉链接），不能按"读全文→语义识别"抽取实体，必须走本节的管线：确定性预处理把机械活（转码、切章、频率普查）做完，LLM 只做语义工作（采样、取证、撰写、链接）。

**判断超长**：`wc -c 源文件` > 1.5MB（约 50 万中文字），或 Read 工具一次读不完（默认上限 2000 行）。未超长的源文件直接通读建页，不必走本管线。

### 步骤 0：断点检查（每次进入必做）

```bash
ls .molio/wiki-build/ 2>/dev/null
node "<skill_dir>/scripts/prep.mjs" status <源文件> --vault .
```

若该源文件已有 `progress-<x>.md` / `candidates-<x>.md`：这是**续传**——不要重跑 prep（除非源文件已变更），不要重置清单。**`status` 输出的 `missingRanges` 就是待办范围清单**（按 `digests/R###.md` 文件是否存在判定，不依赖复选框），只处理这些范围；candidates 只处理未勾选项。构建可能运行数小时，中断是常态，过程文件就是为续传设计的。

### 步骤 1：预处理（确定性，零 LLM）

```bash
node "<skill_dir>/scripts/prep.mjs" <源文件> --vault . [--profile <name>] [--charset <编码>]
```

- **profile 选择**：prep 自动检测（检测到章节结构会选 `novel` 并在 stderr warnings 注明）；你若通读源文件开头后判断不同（如它其实是访谈实录/史料），用 `--profile default` 覆盖。`novel` 提供章节分段 + 中文姓名普查 + 别名扫描；`default` 只做标题分段，不猜实体。自定义 profile 可放 `scripts/profiles/*.json`。
- **编码**：GBK/Big5 等自动探测转码；若 warnings 报有损解码，用 `--charset` 指定后重跑。
- 产物（`.molio/wiki-build/`，文件名取源文件主名）：

| 文件 | 内容 | 覆盖策略 |
|---|---|---|
| `transcode-<x>.txt` | UTF-8 + 行规范化副本（单行 dump 会被切回多行；章节标题独占一行）。**后续所有 grep/Read 的目标，行号是稳定地址** | 总是重生成 |
| `segments-<x>.json` | 结构分段（章/节/标题）+ 处理范围（每范围 ~10 万字 = 一个 L1 subagent 批次），含行号区间 | 总是重生成 |
| `census-<x>.json` | 一趟扫描的频率普查：top N 候选（带类别）、别名线索（X 又名 Y）、已排除的通用词 | 总是重生成 |
| `candidates-<x>.md` | 候选清单（`- [ ] 名字 计数`，频率降序） | **已存在则不覆盖** |
| `progress-<x>.md` | L1 范围清单 + 层级 TODO | **已存在则不覆盖** |

- **建页必须从 candidates/census 取，不要靠记忆或训练知识列名单**——这是让"靠记忆"在结构上不可能的硬约束，记忆只会列出记得住的一小撮名字。census 里的噪音项直接打勾并注明跳过即可。

### 步骤 2：分层构建

每层有独立完成条件。**目标层级**：超长源文件默认建到 L2；中途任何中断，已完成的层级都是可用产物（L1 完成即可支撑章节级问答）。

**L0 结构索引** — prep.mjs 产物本身，零 LLM。

**L1 章节 digest**（覆盖全文，O(总量)）：
- 每个处理范围（segments.json 的一个 range，或相邻若干段，≤15 万字）派一个 **Task subagent**（范围多时可用 Workflow 工具批量编排后台执行）
- subagent 只 Read 自己范围的行号区间（transcode 文件），输出 digest 文件 `.molio/wiki-build/digests/R###.md`：
  - 实体：名字 + 一句话定性 + 首现行号
  - 关键事件与关系（带行号）
  - 别名线索（"X 又叫 Y"类证据）
  - 值得引用的原文（带行号）
- **digest 文件落地 = 该范围完成的唯一信号**（`prep.mjs status` 按 `digests/R###.md` 计数，机械可靠）；progress 复选框可顺手打勾但不是完成依据。每完成一批在 log.md 记一行
- **主 agent 不通读全文，也不把全部 digest 读进自己的上下文**

**L2 实体主表 + 建页**：
- a) **合并去重**：digest 按 10 份一批派 subagent 合并（树形收敛），产出实体主表 `.molio/wiki-build/entity-master.md`：规范名 + 别名 + 身份 + 分布范围。别名以 census.aliasHints + digest 线索为准；频率按别名组汇总（唐三/小三/三哥 的计数合并）。
- b) **建页 subagent**：每批实体一个 subagent，只读主表中该批条目 + 相关 digest 摘录；必要时按行号定点 `grep -nF` 取证补充。**高频名（>200 次提及）取证封顶**：首现 + 章节标题命中 + 均匀采样（每 500 次取 1 条），总量 ≤30 条——无上限的 grep 输出会炸上下文，首现一处对主角也没有代表性。草稿写到 `.molio/wiki-build/drafts/<实体>.md`，**不直接写 wiki/**（并行 subagent 互踩 INDEX/交叉链接/同名页）。
- c) **主 agent 增量安置（分批，别攒到最后）**：每一批建页 subagent 完成后，**立即**把该批草稿按页面类型放入 wiki/、建交叉链接、在 candidates 打勾、向**该页类型所在目录的 INDEX.md** 追加该批条目（根 INDEX 的目录行与计数不逐批更新，由步骤 8 统一重算），然后**再**派下一批。用户在知识库中能实时看到页面逐批增长；若中途打断，已安置的页面不丢，续传只处理 drafts/ 中未安置的草稿。**禁止等全部草稿生成完再一次性安置**——179 个草稿攒到最后安置意味着用户在数小时里看不到任何产出。

**L3 长尾（可选，允许遗留）**：低频候选留给后续 ingest/query 按需补建，在 progress 里留 TODO。**build 不再要求"全量必须当次补全"——但目标层级必须当次完成**，不要停在"已建够"的错觉上。

**后台执行的汇报纪律（重要）**：
- 用 Workflow/后台 subagent 执行 L1 时，汇报**只说你已启动什么 + 用户如何查进度**（"`prep.mjs status` 或问我当前进度"），不要引用运行时不存在的界面能力（`/workflows` 是 Claude Code REPL 专属命令，Molio 对话面板里没有）
- **不要承诺"自动接续下一步"**——后台任务完成后能否自动唤醒下一轮取决于运行时；告诉用户"如果长时间没有动静，发任意消息或重新说'构建 wiki'即可从断点续传"
- 汇报内容必须基于已核实的事实（先 ls 确认产物在写入），不要预报尚未发生的完成
- **收尾汇报硬规则**：汇报"INDEX/log/hot 已写好""过程文件已清理"等任何完成状态之前，必须先用 `ls`/`find` 实际核验（文件确实存在、非空、时间戳是本次写入）；页面数、分类数等数字必须取自当场 `find wiki -name '*.md' | wc -l` 之类统计的实时输出——**禁止凭记忆报数，更禁止复用别的库或上次构建的数字**。报过"已写好"而文件不在、报过"已清理"而文件还在，是本 skill 最严重的失信行为

### 步骤 3：完成自检（硬性，机械判定）

```bash
node "<skill_dir>/scripts/prep.mjs" status <源文件> --vault .
```

- `rangesDone` 按 `digests/R###.md` 文件计数（机械事实，不看复选框）；`missingRanges` 直接给出待办范围
- L2 达标 = `rangesDone == rangesTotal` 且 candidates 全部打勾（`complete: true`）
- L1 达标 = `rangesDone == rangesTotal`
- 未达标 → 继续处理 `missingRanges` 里的范围/未勾选候选，不要自判"差不多了"

### 步骤 4：引用抽查（防幻觉）

```bash
node "<skill_dir>/scripts/prep.mjs" verify <wiki页面> .molio/wiki-build/transcode-<x>.txt
```

安置完成后抽查若干实体页：页面里「」/“”引号内的引文会逐条在原文中验证。`missing` 非空 → 引文是编造或转述失准，按原文修正。

多源文件场景：每个源文件各一套过程文件，逐个走完整管线。

## 操作步骤

1. **扫描**：读取 vault 中所有源文件（跳过隐藏文件、wiki/ 和 .molio/ 本身），了解全貌，用 `wc -c` 标出超长文件
2. **断点检查 + 预处理**：超长文件先走"超长源文件处理"步骤 0→1；普通文件通读
3. **规划**：列出打算创建的页面清单和类型，确定目录结构
4. **检查已有 wiki**：如果 wiki/ 已存在，先读根 INDEX.md + 相关目录的 INDEX.md 了解已有内容，只新增/更新，不重复创建；若发现是旧单索引布局（根 INDEX 逐页罗列、无目录索引），先按「索引分层迁移」重构索引再继续
5. **生成页面**：普通文件逐个建页；超长文件按 L1 digest → L2 主表+建页的分层流程执行，每轮打勾推进度
6. **完成自检**：`prep.mjs status` 确认目标层级达标，未达标继续补建
7. **引用抽查**：`prep.mjs verify` 抽查实体页引文
8. **创建/更新根 INDEX.md + 各目录 INDEX.md**（分层结构，目录行页数在此统一重算）、**log.md**、**hot.md**
9. **汇报**：页面数量、核心论点摘要、剩余知识缺口（L3 长尾；高频实体应已在自检中补全）

页面内容要全面但简洁，优先保证准确性。
