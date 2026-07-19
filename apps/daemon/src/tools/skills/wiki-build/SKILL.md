---
name: wiki-build
description: 构建/重建本地知识库的 Wiki（CLI 工作流，可恢复）。扫描 vault 中所有源文件，按语义领域分组为主题，逐主题生成结构化 wiki 页面（源文件摘要、实体、概念、对比、概述），密集交叉链接，支持断点续传和长文件预处理。Triggers on: 构建 wiki, 重建 wiki, build wiki, 扫描源文件构建, 初始构建, 重新构建知识库, start wiki build.
version: 2.0.0
---

# wiki-build: 构建 Wiki

wiki 不是一次性的输出，而是一个持续增长的复利资产 — 每次构建、导入、查询都会让它更丰富。

## 核心原则

- **源文件不可变**：源文件（notes/、docs/ 等）是用户的原始资料，只能读取，绝对不能修改或删除。
- **密集交叉链接**：[[wiki 链接]] 是这个知识库的核心价值。每个页面都应大量链接到其他相关页面，形成知识网络。宁可多链接，不要少链接。
- **合成而非搬运**：wiki 不是源文件的简单摘要集合，而是要提炼出跨源文件的综合观点、论点和洞察。
- **结构化元数据**：每个页面必须带完整的 frontmatter，这是知识网络可查询、可审计的基础。

## Vault 结构

vault 根目录就是当前工作目录。源文件在子目录中（如 raw/、notes/、docs/）。
wiki 相关内容的目录结构：

### 递归主题布局（v2.0.0）

- `raw/` — 未处理的原始资料目录
- `raw/wechat/` — 微信通道收到的网页、文件等原始资料统一先放在这里
- `wiki/INDEX.md` — 递归 Wiki 的根索引，列出顶层主题及摘要
- `wiki/<topic>/INDEX.md` — 中间主题索引，列出子主题及摘要
- `wiki/<topic>/.../<leaf>/INDEX.md` — 叶主题索引，列出该主题下所有页面
- `wiki/<topic>/.../<leaf>/index-shards/` — 分片目录（当叶主题页面数超过容量时使用）
- `wiki/log.md` — 按时间顺序记录的操作日志（最新条目在最上面）
- `wiki/hot.md` — 近期上下文缓存（~500 字，每次操作后刷新）
- `wiki/meta/` — 元数据目录（lint 报告等）

### Legacy 兼容

Legacy wiki 可能仍使用扁平 `wiki/INDEX.md`（所有页面直接列在根索引下）。遇到这种情况按原样读取即可，不要主动迁移到递归布局。

### 页面路径规则

- 默认使用单文件页面。**文件名 = 实体/概念的规范名本身**：中文内容用中文名直做文件名（如 `wiki/<topic>/李白.md`），英文内容用 kebab-case（如 `wiki/<topic>/molio.md`）。`[[wiki 链接]]` 的链接名必须与目标文件名（去掉 `.md`）完全一致——`[[李白]]` 对应 `李白.md`，写成 `libai.md` 会断链
- 只有当某个实体、项目或主题需要拆成多个稳定页面时，才建立同名目录，并用 `index.md` 作为该目录入口
- 同名目录下的子页面必须围绕该入口主题展开
- 不要把项目命名空间强行放进错误的内容类型目录；目录首先按语义主题归类，再按内容自然生长

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
- **source**（源文件摘要）— 每个源文件一个摘要页，提取关键信息
- **entity**（实体）— 人物、组织、工具等命名实体
- **concept**（概念）— 关键概念、想法、模式、框架
- **comparison**（对比）— 相关概念或方法之间的对比分析
- **overview**（概述）— 当源文件较多（≥5 篇）且跨多个主题时创建，提炼跨源文件的核心论点

目录结构应从内容中自然生长，不要强行套用固定模板。如果源文件只有几篇且主题集中，扁平结构就够用。

## 建页粒度

哪些实体独立建页、哪些收纳进概念页，按**内容能否支撑独立页面**判断（不靠频率百分比或绝对次数——不同长度/领域的源文件频率分布差异大，阈值会失真）：

应建独立页（任一满足）：
- 出现在章节标题/目录中（强信号，必有内容可写）
- 能用 `grep -nF 名字` 取到足够上下文写出有实质内容的独立描述（首次出现 + 身份归属 + 至少一个关键事件/关系）

只有零星提及（如"某某点头""某某路过"，grep 取证写不出实质内容）→ 放概念页表格行，不独立建页。

不同源文件的粒度不同，按各自内容特征独立判断。

## 超长源文件处理

源文件若无法在一次上下文内通读（通读后还要留空间规划+生成+交叉链接），不能按"读全文→语义识别"抽取实体，必须先做可检索预处理。

**预处理管线**（由 CLI 自动编排，产物位于 `.molio/wiki-build/normalized`）：
- **docling 输出**：PDF/DOCX/PPTX 等非文本源文件经 docling 转换为结构化 Markdown，输出到 `.molio/wiki-build/normalized/`
- **文本标题/窗口分块**：纯文本源文件按标题层级或固定窗口切分为可检索的块
- **JSON 流式策略**：超长文件以 JSONL 格式逐块流式处理，避免单次上下文溢出

**判断是否超长**：
```bash
wc -m 源文件          # 中文 1 字 ≈ 1.5 token，token ≈ 字符数 × 1.5
```
若 token 数 > 当前上下文的 30%，或 Read 工具一次读不完（默认上限 2000 行），即为超长。

**不支持的文件格式**：扫描阶段发现无法处理的文件格式时，CLI 会将其标记为 `unsupported`。在对话中列出这些文件，取得用户确认后运行 `skip --file-id <id> --reason "<reason>"` 跳过。

## 操作步骤（CLI 工作流）

1. 运行 `node "<wiki-build-skill>/scripts/wiki-build.mjs" scan --json`。
2. 只读取 `inventory.jsonl` 和样本，不得再次遍历或读取整个 vault。
3. 按语义领域对文件分组。即使主题只有一个文件，互不相关的文件也必须分开。
4. 应用容量细分并写入候选计划 JSON。
5. 运行 `plan --input "<candidate>" --mode validate --json`。
6. 在对话中展示主题、文件分配、排除项、待决定文件、风险和工作量。
7. 等待用户批准。用户明确批准前，不得运行 `approve`，也不得写入 `wiki/`。
8. 运行 `plan --input "<candidate>" --mode approve --json`。
9. 运行 `status --json`。恢复会话时，先展示剩余工作，并在运行 `status --recover` 前取得确认。
10. 循环执行 `next -> 标准化受限输入 -> 在返回的 stagingDir 下写入完整页面 -> checkpoint`。
11. 用户要求排除文件时运行 `skip --file-id`；出现可重试失败时运行 `retry --file-id`。
12. 写入 `topic-summaries.json`，然后运行 `finalize --summaries "<path>" --json`。
13. 根据最终 JSON 结果报告已完成、失败、跳过和未解决的文件。

**`checkpoint` 输入要求**：`checkpoint` 命令的输入 JSON 必须包含 `attemptToken` 字段（从 `next` 或 `prepare` 的返回值中获取），用于确保写入操作属于当前批次，防止过期批次覆盖新状态。

## wiki/INDEX.md 格式

按实际创建的主题组织，每个页面一行：链接 + 一句话摘要。

```markdown
# Wiki 索引

## 主题 A
- [[topic-a]] — 主题摘要

## 主题 B
- [[topic-b]] — 主题摘要
```

叶主题 INDEX.md：
```markdown
# 主题名 索引

## 源文件摘要
- [[source-page]] — 一句话摘要

## 实体
- [[entity-page]] — 一句话描述

## 概念
- [[concept-page]] — 一句话描述
```

## wiki/log.md 格式

最新条目在最上面：
```markdown
# 构建日志

## YYYY-MM-DD HH:MM | build | 初始构建
- 扫描源文件数：N
- 创建页面数：N（按类型列出）
- 关键发现：一句话概述
```

页面内容要全面但简洁，优先保证准确性。
