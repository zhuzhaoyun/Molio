---
name: wiki-build
description: 构建/重建本地知识库的 Wiki。扫描 vault 中所有源文件，从中构建一个结构化的 wiki（源文件摘要、实体、概念、对比、概述页），创建 INDEX/log/hot，密集交叉链接。Triggers on: 构建 wiki, 重建 wiki, build wiki, 扫描源文件构建, 初始构建, 重新构建知识库, start wiki build.
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
- `raw/` — 未处理的原始资料目录
- `raw/wechat/` — 微信通道收到的网页、文件等原始资料统一先放在这里
- `wiki/` — 所有 wiki 页面的根目录
- `wiki/INDEX.md` — 主索引，列出所有页面及一句话摘要
- `wiki/log.md` — 按时间顺序记录的操作日志（最新条目在最上面）
- `wiki/hot.md` — 近期上下文缓存（~500 字，每次操作后刷新）
- `wiki/meta/` — 元数据目录（lint 报告等）
- `wiki/sources/` — 源文件摘要页，由 raw/、notes/、docs/ 等原始资料生成；不要把原始资料直接放入这里
- `wiki/entities/` — 人物、组织、工具等实体页
- `wiki/concepts/` — 概念、模式、框架等
- `wiki/comparisons/` — 对比分析页
- `wiki/questions/` — 归档的问答页

页面路径规则：
- 默认使用单文件页面，例如 `wiki/entities/molio.md`、`wiki/concepts/agent-routing.md`
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

## wiki/INDEX.md 格式

按实际创建的分类组织，每个页面一行：链接 + 一句话摘要。

```markdown
# Wiki 索引

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

## 操作步骤

1. **扫描**：读取 vault 中所有源文件（跳过隐藏文件和 wiki/ 本身），了解全貌
2. **规划**：分析内容，列出你打算创建的页面清单和类型，确定目录结构
3. **检查已有 wiki**：如果 wiki/ 已存在，先读 INDEX.md 了解已有内容，只新增/更新，不重复创建
4. **生成页面**：逐个创建 wiki 页面，每个页面都要带完整 frontmatter 和大量 [[wiki 链接]]
5. **创建 INDEX.md**：完整列出所有页面
6. **创建 log.md**：记录本次构建
7. **创建 hot.md**：生成近期上下文缓存（~500 字摘要）
8. **汇报**：页面数量、核心论点摘要、发现的知识缺口（建议用户后续补充什么方向的资料）

页面内容要全面但简洁，优先保证准确性。
