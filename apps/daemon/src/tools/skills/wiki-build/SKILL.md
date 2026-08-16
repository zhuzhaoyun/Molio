---
name: wiki-build
description: 构建/重建本地知识库的 Wiki。扫描 vault 中所有源文件，从中构建一个结构化的 wiki（源文件摘要、实体、概念、对比、概述页），创建分层 INDEX（根索引 + 各目录索引）/log/hot，密集交叉链接。支持超长源文件（百万字级小说等）：prep.mjs 确定性预处理 + 分层 digest 构建 + 断点续传。也能把旧单索引库的索引重构为分层布局。Triggers on: 构建 wiki, 重建 wiki, build wiki, 扫描源文件构建, 初始构建, 重新构建知识库, start wiki build, 重构索引, 索引分层, 索引迁移, restructure index.
version: 2.0.0
---

# wiki-build: 构建 Wiki

wiki 不是一次性的输出，而是一个持续增长的复利资产 — 每次构建、导入、查询都会让它更丰富。

> **维护注记**：wiki-* 五件套（build/query/ingest/save/lint）同版本号共进——改任一 skill 时，五个 `version:` 一起 bump 到同一下一个版本。

## 核心原则

- **源文件不可变**：源文件（notes/、docs/ 等）是用户的原始资料，只能读取，绝对不能修改或删除。
- **密集交叉链接**：[[wiki 链接]] 是这个知识库的核心价值。每个页面都应大量链接到其他相关页面，形成知识网络。宁可多链接，不要少链接——但**只链接最终页面集合里存在的页面**：没有页面的名字在正文中一律用纯文本（或先建 stub 页再链）。收尾对账（deadcheck/linkpass，见"链接对账"节）机械保证零死链、零漏链。
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

哪些实体建页、建什么样的页，按**信息落点判断，不按实体类别**。判据只问三个**结构量**，与语料领域无关——同一套规则适用于小说、史书、技术文档、论文任何语料；不要按"某类东西该建/不该建"的领域直觉分类（人物/地点/器物/概念在各自语料中的重要度完全不同，预置类别会把管线锁死在一种语料上）：

1. **覆盖深度**：它出现在几个独立区段/章节（跨度）。可机械统计（census/segments）。
2. **独立信息量**：去掉它，已有页面是否仍能完整表达同等信息。若它的全部内容可并入一句描述 → 没有独立落点。
3. **引用需求**：其他页面是否把它的名字当作**讨论对象**、而不是行文背景来提及（判法见下）。

分三档：

**完整页**（任一满足）：
- 出现在章节标题/目录中（强信号，必有内容可写）
- 能用 `grep -nF 名字` 取到足够上下文写出有实质内容的独立描述（首次出现 + 身份归属 + 至少一个关键事件/关系），且**跨度≥2 区段**。跨度=1 的内容通常不足以当独立页——除非它承载了不可并入其他页的关键信息。

**stub 页**（内容撑不起完整页，但有**引用需求**）：
- 格式：完整 frontmatter + `stub: true` 标记 + 一句话身份定性（必须 grep 取证，不靠记忆）+ 关键关系链接，3-8 行即可
- 判据只有一个：**其他页面会主动链接它**（它是文本中反复被"讨论"的话题，即使篇幅小）。判断方法见下一节"讨论对象 vs 背景挂点"。
- 图谱/问答链路需要这些中间节点（别处提及时钟链到它）；缺了就是死链或漏链。

**不建页**（噪音）：
- 通用词、尊称、无名字的泛称（"某某的娘""某某家的"这类）→ 收纳进相关页的一句话或概念页表格行
- **仅作行文背景、不被讨论**的名字（判据见下）→ 正文出现用纯文本，**禁止**建页、**禁止**在正文中以 `[[ ]]` 出现
- 判定启发式：**跨度=1 且内容可并入其他页面的一句话** → 不建页（信息已被承载，单独立页是重复，只会产生一张空洞的 stub 图）

### 讨论对象 vs 背景挂点（领域无关的二元判据）

对正文里每个候选名字的每一处提及，问：**它是被"讨论"还是被"用作背景"？**
- **讨论对象**：句子以它为主语/宾语在陈述它的属性、行为、关系（"**X** 在 N 处做了某事，因其 Y 而被 Z 所知"；读者查它是因为它本身构成话题）。此类提及即使零散，也指向实体。
- **背景挂点**：它只出现在方位/工具/附属语境里，删掉或换成泛指后句子语义不变（"某事发生在 P 处""用 T 完成了……""安置于 Q"——P/T/Q 是描述其他实体的背景，读者查的是句子的主体而不是它）。

同一句话里两者可并存（"发生在 R 的那个事件"——R 是背景；"事件本身"是讨论对象）。逐处判定时要看**这句话的语义中心**，不是按候选名所属的领域类别划分。拿不准时用**删除测试**：把该名字从所有出现处换成纯文本/泛指，若任何页面的可读性都不受损 → 背景挂点，不建页；若某处去掉后话题悬空（读者会问"它到底是谁"）→ 有引用需求，建 stub 都值得。

不同源文件的粒度不同，按各自内容特征独立判断。census 频率是排序信号，不是建页阈值。**建了 stub 不代表必须留着**：收尾时对入度=0 的 stub 做孤儿审计（见步骤 3），确认是背景挂点误建就删除/降级为纯文本。

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

## 超长源文件处理（prep + curation + 建页 + 对账）

源文件若无法在一次上下文内通读（通读后还要留空间规划+生成+交叉链接），不能按"读全文→语义识别"抽取实体，必须走本节的管线：确定性预处理把机械活（转码、切章、频率普查）做完，agent 只做语义工作（curation 审核、取证、撰写、链接）。

**判断超长**：`wc -c 源文件` > 1.5MB（约 50 万中文字），或 Read 工具一次读不完（默认上限 2000 行）。未超长的源文件直接通读建页，不必走本管线。

### 步骤 0：断点检查 + 构建权（每次进入必做）

```bash
ls .molio/wiki-build/ 2>/dev/null
node "<skill_dir>/scripts/prep.mjs" status <源文件> --vault .
node "<skill_dir>/scripts/build-lock.mjs" acquire "build-<x>-<日期>" --vault .
```

- 若已有 `curation-<x>.tsv` / `batches/`：这是**续传**——不要重跑 prep/curation，直接从断点继续建页。
- 同一 vault 一次只允许一个构建会话。label 用 "build-<源文件主名>-<日期>" 固定，整个构建过程（含断开续传）都传同一 label。异 label 锁 → exit 1，不要抢。
- 构建结束时：`build-lock.mjs release "build-<x>-<日期>" --vault .`

### 步骤 1：预处理（确定性，零 LLM）

```bash
node "<skill_dir>/scripts/prep.mjs" <源文件> --vault . [--profile <name>] [--charset <编码>]
```

- **profile 选择**：prep 自动检测（检测到章节结构会选 `novel` 并在 stderr warnings 注明）；你若通读源文件开头后判断不同（如它其实是访谈实录/史料），用 `--profile default` 覆盖。自定义 profile 可放 `scripts/profiles/*.json`。**注意**：若 prep 回退到 default 且 candidates 为 0，说明 profile 不匹配——必须定制 profile 而非继续。
- **编码**：GBK/Big5 等自动探测转码；若 warnings 报有损解码或 PUA 字符，用 `--charset` 指定后重跑。
- 产物（`.molio/wiki-build/`）：`transcode-<x>.txt`（行号稳定地址）、`segments-<x>.json`（分段+范围）、`census-<x>.json`（频率普查+别名线索）

### 步骤 2：L1 章节 digest（覆盖全文）

每个处理范围（segments.json 的一个 range，≤15 万字）派一个 subagent，只 Read 自己范围的行号区间，输出 `digests/R###.md`（实体+定性+事件+行号+别名线索）。**digest 文件落地 = 该范围完成的唯一信号**。主 agent 不通读全文。

### 步骤 3：curation（信息落点判据，脚本预填 + agent 审核）

这是整条管线的**核心决策环节**——决定建哪些页、什么类型、怎么分批。

```bash
# 3a. 脚本预填：census → 草稿 TSV（机械映射，零 LLM）
node "<skill_dir>/scripts/curate.mjs" draft <x> --vault .

# 3b. agent 审核草稿：按「建页粒度」判据筛选、分组、标注页类
#     产出: curation-<x>.tsv（审核后的最终版）

# 3c. 脚本分批：校验格式 + 按 # cat= 分组 + 单批超 15 条自动拆分
node "<skill_dir>/scripts/curate.mjs" split <x> --vault .
```

**批次 TSV 格式**（制表符分隔，每行 5 列）：
```
# cat=<类别标签>
名字	定性	别名: X/Y/Z	证据行号: N,N,N	页类: entity|concept
```

**agent 审核时做什么**（脚本做不了的语义判断）：
- 按「建页粒度」的信息落点判据筛选：删噪音、删背景挂点、保留有引用需求的
- 按主题分组（`# cat=帝系` / `# cat=概念与制度页` 等）——**批次即类型标签**
- 每行标注 `页类: entity` 或 `页类: concept`
- 补全别名（从 census.aliasHints / digest 中认领）
- 补全证据行号（代表性行号，不是全量）

**脚本预填做什么**（机械部分，agent 不需花 token）：
- 按 count 排序、过滤低频噪音
- 预填唯一匹配的别名
- 预填证据行号（census 有则填，无则留空）

**批次规模**：留白为主（按主题自然分组），脚本兜底（单批超 15 条自动拆分）。

### 步骤 4：建页（每批一个 subagent）

每个批次派一个 subagent，读批次 TSV 该批行 + transcode 取证 → 写 `drafts/<名字>.md`。

- **一个 subagent 只做一批，即读即写**，不要预先规划多个批次（防 32k 输出上限）
- prompt 按 `页类` 给模板：concept 页写综合论述，entity 页写身份+事件+关系
- 建页 agent 只能链接**批次 TSV 里出现的名字**（白名单），清单外用纯文本
- 高频名取证封顶：首现 + 均匀采样，总量 ≤30 条
- **并发 ≤5-6 个 subagent**（防 API 429 限流）；完成度以磁盘落盘为准，不信通知

### 步骤 5：安置（确定性，零 LLM）

```bash
node "<skill_dir>/scripts/place.mjs" <x> --vault .
```

- 按批次 TSV 的 `页类` 列分发：entity → `wiki/entities/`，concept → `wiki/concepts/`
- 生成/更新对应目录的 INDEX.md（摘要自动提取）
- 幂等可重跑；中途打断后续传只需重跑 place

### 步骤 6：链接对账（硬性门禁，exit 0 才算通过）

```bash
node "<skill_dir>/scripts/linkpass.mjs" --vault . --batches .molio/wiki-build/batches
node "<skill_dir>/scripts/deadcheck.mjs" --vault .
```

- `linkpass --batches`：从批次 TSV 的别名列读取别名映射，把每个页面名/别名在其他页面正文中的首次出现包成 `[[ ]]`。**庙号/别名死链在这一步自动消解**（如"项王"→`[[项羽|项王]]`）
- `deadcheck`：exit 0 才算通过。有死链 → 补页或改写链接，重跑直至 exit 0

### 步骤 7：引文核验（确定性，零 LLM）

```bash
node "<skill_dir>/scripts/sweep.mjs" <x> --vault .
```

- 全量 verify + **missing 分类**：`wikilink`（链接误报）/ `blockquote`（整行提取噪音）/ `pua`（转码差异）/ `real`（真错）
- **只修 `real` 类**：写进 `rules.json` 的 `repair.repl`，跑 `repair.mjs` 双份修复（wiki + drafts）
- 其他三类是机械噪音，不需要修

### 收尾

- 创建/更新根 INDEX.md + log.md + hot.md
- `build-lock.mjs release`
- 汇报（页面数必须用 `find wiki -name '*.md' | wc -l` 实时统计，禁止凭记忆报数）

多源文件场景：每个源文件各一套过程文件，逐个走完整管线；链接对账是全库级的，所有源文件安置完后跑一次即可。

## 操作步骤

1. **扫描**：读取 vault 中所有源文件（跳过隐藏文件、wiki/ 和 .molio/ 本身），了解全貌，用 `wc -c` 标出超长文件
2. **断点检查 + 构建权 + 预处理**：超长文件先走"超长源文件处理"步骤 0→0.5（build-lock acquire）→1；普通文件通读
3. **规划**：列出打算创建的页面清单和类型，确定目录结构
4. **检查已有 wiki**：如果 wiki/ 已存在，先读根 INDEX.md + 相关目录的 INDEX.md 了解已有内容，只新增/更新，不重复创建；若发现是旧单索引布局（根 INDEX 逐页罗列、无目录索引），先按「索引分层迁移」重构索引再继续
5. **生成页面**：普通文件逐个建页；超长文件按 L1 digest → L2 主表+建页的分层流程执行（merge-master 合并、batcher 分片、G1/G2 门禁）
6. **完成自检**：`prep.mjs status` 确认目标层级达标 + **孤儿 stub 审计**，未达标继续补建
7. **引用抽查**：`sweep.mjs` 全量 verify → `repair.mjs`（rules.json 修复表）修正失准引文，重跑直至归零
8. **链接对账**：`linkpass.mjs` 补漏链 → `deadcheck.mjs` 门禁，**必须 exit 0**；有死链先补 stub 或改写再重跑
9. **创建/更新根 INDEX.md + 各目录 INDEX.md**（分层结构，目录行页数在此统一重算，stub 页也要列入）、**log.md**、**hot.md**
10. **收尾**：`build-lock.mjs release`（释放构建权）
11. **汇报**：页面数量、核心论点摘要、剩余知识缺口（从不被链接的 L3 长尾；高频实体应已在自检中补全）；汇报必须包含"死链 0（deadcheck 通过）"

页面内容要全面但简洁，优先保证准确性。
