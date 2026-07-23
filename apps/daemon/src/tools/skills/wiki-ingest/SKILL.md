---
name: wiki-ingest
description: 将源文件/资料增量导入（入库）到现有 wiki，使知识持续积累和演进。读取源文件，生成或更新 source 摘要页与实体/概念/对比等页面，建立交叉链接，检测矛盾，更新分层 INDEX/log/hot（旧单索引库首次入库时自动升级为分层索引）。支持显式文件路径、URL、或无显式目标时自动找最近 raw/wechat 暂存资料。Triggers on: 入库, 导入, 整理进知识库, 保存到知识库, 归档这个文件, ingest, add this to the wiki, process this source, 把这个文件加入 wiki, read and file this.
version: 1.6.0
---

# wiki-ingest: 增量导入（入库）

将指定的源文件（或资料）增量导入到现有 wiki 中，使 wiki 的知识持续积累和演进。

## 核心原则

- **源文件不可变**：只能读取源文件，绝对不能修改或删除。
- **积累而非替换**：新内容要融入现有 wiki 的知识网络，而不是孤立地添加新页面。
- **密集交叉链接**：新页面要大量链接到已有页面，已有页面如果与新内容相关也要添加反向链接。
- **矛盾检测**：新信息与已有 wiki 内容冲突时，必须明确标注。

## Vault 结构

vault 根目录就是当前工作目录。源文件在子目录中（如 raw/、notes/、docs/）。
wiki 相关内容的目录结构：
- `raw/` — 未处理的原始资料目录
- `raw/wechat/` — 微信通道收到的网页、文件等原始资料统一先放在这里
- `wiki/` — 所有 wiki 页面的根目录
- `wiki/INDEX.md` — 根索引：只列目录级概览（各目录页数 + 覆盖范围）与概述入口页，不逐页罗列
- `wiki/<dir>/INDEX.md` — 每个内容目录（sources/entities/concepts/comparisons/questions）自己的索引，列全该目录页面及一句话摘要
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
- 同名目录下的子页面必须围绕该入口主题展开
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

## Hot Cache

`wiki/hot.md` 是近期上下文缓存，用于快速恢复上下文。格式：

```markdown
# 近期上下文

> 最后更新：YYYY-MM-DD HH:MM

## 最近操作
- [操作描述]

## 关键页面
- [[页面名]] — 为什么重要

## 开放问题
- 尚未解决的问题或待跟进的事项
```

管理规则：
- 每次 build/ingest/lint/save 操作完成后，**完全重写** hot.md（不是追加）
- 内容控制在 ~500 字以内
- 重点是让下次会话能快速理解 wiki 当前状态

## 确定导入目标

- **显式文件路径**：用户消息里给了文件路径（如「把 xxx 加入 wiki」「导入：/path/to/file」），直接读该文件。
- **URL / 网页分享**：用户给了 http 链接。`mp.weixin.qq.com` 链接**必须**用 `wechat-article-extractor` skill 提取正文，**禁止用 WebFetch**（会被企业安全策略拦截）：
  ```bash
  node "<skill_dir>/extract.js" "<url>"
  ```
  `<skill_dir>` 是 vault 下 `.claude/skills/wechat-article-extractor/` 的绝对路径。脚本 stdout 输出 Markdown 正文，stderr 输出一行 JSON 元数据（含 title/author/account/publishTime）。退出码为 2（内容不可用）时不要重试，提示用户手动粘贴正文。非 `mp.weixin.qq.com` 链接按一般 URL 处理。
- **无显式目标（如只说「入库」「整理进知识库」）**：找 `raw/wechat/YYYY-MM-DD/` 下最近一次新增的暂存资料（实体文件或 `.md`）作为导入目标。如果有多份或无法确定，先问用户确认，不要猜测。

实体文件（PDF/图片等）本身就是暂存资料，直接读其内容做摘要，**不要再额外新建 `.md` 暂存文件**，也不要重命名或移动它。

## 超长源文件处理

源文件超长（`wc -c` > 1.5MB，约 50 万中文字，或 Read 一次读不完）时，**复用 wiki-build 的预处理管线**（两个 skill 同批安装于 `.claude/skills/`）：

```bash
# 断点检查（每次进入必做；已有 progress/candidates → 续传，勿重跑 prep）
node ".claude/skills/wiki-build/scripts/prep.mjs" status <源文件> --vault .
# 预处理：转码 + 行规范化 + 分段 + 频率普查（确定性，零 LLM）
node ".claude/skills/wiki-build/scripts/prep.mjs" <源文件> --vault . [--profile novel|default]
```

产物在 `.molio/wiki-build/`：`transcode-<x>.txt`（grep/Read 目标，行号稳定）、`segments-<x>.json`（分段+范围）、`census-<x>.json`（频率普查+别名线索）、`candidates-<x>.md` / `progress-<x>.md`（已存在不覆盖，续传依据）。

ingest 与 build 的差别：

- **建页名单取 candidates/census，不靠记忆列名字**（同 build 的硬约束）；census 噪音项打勾注明跳过即可。
- **已有清单则复用**：该源文件若被 build 处理过，只处理未勾选且与本次入库相关的候选，不要 `--force` 重置。
- **增量融合**：新页面必须与现有 wiki 页面建立反向链接、检测矛盾（见下方操作步骤）——这是 ingest 独有的要求。
- **分层消化**：每个处理范围（≤15 万字）派 Task subagent 读行号区间、产出 digest（实体+定性+事件+行号引用），主 agent 从 digest 建页、安置、打勾；主 agent 不通读全文。草稿先落 `.molio/wiki-build/drafts/` 再由主 agent 安置，避免并行互踩。
- **高频名取证封顶**：首现 + 标题命中 + 均匀采样（每 500 次取 1），总量 ≤30 条。
- **ingest 不要求全量**：候选可分批处理，剩余留未勾选（与 build 不同）；但本次认领的范围要处理完。
- **完成自检（机械判定）**：`prep.mjs status <源文件> --vault .` —— 认领范围全部打勾即可收工。

## 旧库索引自动升级（首触自愈）

若 wiki 仍是旧单索引布局（根 `wiki/INDEX.md` 以 `- [[页面]] — 摘要` 逐页罗列、内容目录无 INDEX.md），**在本次入库前先自动完成索引分层迁移**（只重构索引，不动页面文件）：

1. `find wiki/ -name '*.md'` 一次，建「页名 → 所在目录」映射
2. 旧根 INDEX 的页面条目按映射分流写入各目录的 INDEX.md（保留原摘要；条目多则 `##` 分组）
3. 根 INDEX.md 改写为分层结构：概述条目内联，其余目录各一行（目录链接 + 页数 + 覆盖范围）

过程幂等（目录索引已存在即跳过）；执行后在回答末尾告知用户「索引布局已升级为分层」。布局规范详见 wiki-build SKILL.md「索引分层结构」节。

## 操作步骤

1. **读取源文件**：读取目标源文件/资料，理解其内容。**超长文件走"超长源文件处理"路径，不要通读**
2. **读取现有 wiki**：读根 `wiki/INDEX.md` + 相关目录的 INDEX.md，了解现有结构和已覆盖内容；**若发现是旧单索引布局，先按上节完成索引升级再继续**
3. **扫描相关页面**：读取与新内容最相关的已有 wiki 页面（3-5 个），了解已有知识
4. **分析关联**：
   - 新内容有哪些重要洞察？
   - 与现有 wiki 有哪些关联、补充或矛盾？
   - 计划创建和更新哪些页面？
5. **创建/更新页面**：
   - 根据现有 wiki 结构选择合适的页面类型和目录
   - 新页面必须带完整 frontmatter 和 [[wiki 链接]]
   - 如果新内容改变了全局认知，更新 overview 页面（如果存在）
   - **超长文件按"超长源文件处理"段落的分层消化执行**：subagent 按范围产出 digest → 主 agent 从 digest 建页安置 → 打勾推进度，多轮累积——不要单轮通读完成
6. **反向更新交叉链接**：如果新页面与已有页面相关，在已有页面中也添加 [[wiki 链接]]
7. **矛盾处理**：如果新信息与已有 wiki 内容冲突：
   - 在两个页面中都添加 `> [!contradiction]` callout 标注
   - 说明矛盾的具体内容和可能的解决方向
   - 告知用户
8. **更新索引**：新页面条目写入**所在目录的 INDEX.md**，已修改页面的描述同步更新；根 INDEX.md 的对应目录行更新页数与覆盖范围（新目录则补一行）
9. **追加 wiki/log.md**（最新条目在最上面）：
   ```
   ## YYYY-MM-DD HH:MM | ingest | 文件名
   - 创建页面数：N
   - 更新页面数：N
   - 关键发现：一句话概述
   ```
10. **刷新 wiki/hot.md**：完全重写，包含本次操作的摘要和当前 wiki 状态
11. **汇报**：创建和更新了哪些页面，发现了哪些矛盾或知识缺口

## 建页粒度

按**内容能否支撑独立页面**判断建页粒度（不靠频率百分比或绝对次数——不同长度/领域的源文件频率分布差异大，阈值会失真）：

应建独立页（任一满足）：
- 出现在章节标题/目录中（强信号，必有内容可写）
- 能用 `grep -nF 名字` 取到足够上下文写出有实质内容的独立描述（首次出现 + 身份归属 + 至少一个关键事件/关系）

只有零星提及（如"某某点头""某某路过"，grep 取证写不出实质内容）→ 放概念页表格行，不独立建页。

不同源文件的粒度不同，按各自内容特征独立判断。

## 入库页面规则

- `wiki/sources/` 只放 source 摘要页，不放原始资料。
- 默认使用单文件页面。**文件名 = 实体/概念的规范名本身**：中文内容用中文名直做文件名（如 `wiki/entities/李白.md`），英文内容用 kebab-case（如 `wiki/entities/molio.md`）。`[[wiki 链接]]` 的链接名必须与目标文件名（去掉 `.md`）完全一致——`[[李白]]` 对应 `李白.md`，写成 `libai.md` 会断链。
- 只有当某个实体、项目或主题需要拆成多个稳定页面时，才建立同名目录，并用 `index.md` 作为该目录入口。
- 新页面必须包含完整 frontmatter，并与相关页面建立 [[wiki 链接]]。
- 新信息与已有 wiki 内容冲突时，明确标注矛盾并告知用户。

如果新内容与现有 wiki 页面存在矛盾，在两个页面中都要明确标注，并告知用户。
