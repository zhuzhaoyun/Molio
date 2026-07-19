---
name: wiki-ingest
description: 将源文件/资料增量导入（入库）到现有递归 Wiki，使知识持续积累和演进。读取源文件，逐级读取 INDEX 定位目标主题，生成或更新 source 摘要页与实体/概念/对比等页面，建立交叉链接，运行 reindex 更新叶主题及祖先索引。支持 legacy 扁平 wiki 兼容。Triggers on: 入库, 导入, 整理进知识库, 保存到知识库, 归档这个文件, ingest, add this to the wiki, process this source, 把这个文件加入 wiki, read and file this.
version: 2.0.0
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

Legacy wiki 可能仍使用扁平 `wiki/INDEX.md`（所有页面直接列在根索引下，无子主题目录）。检测到这种情况时，使用旧的扁平流程：直接读取根 INDEX 定位相关页面，新增/更新页面写入 `wiki/` 根目录，更新根 INDEX。不要主动迁移到递归布局。

### 页面路径规则

- 默认使用单文件页面，例如 `wiki/<topic>/molio.md`、`wiki/<topic>/agent-routing.md`
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

源文件若无法在一次上下文内通读（通读后还要留空间分析关联+生成页面+交叉链接），不能按"读全文→语义识别"抽取实体，必须先做可检索预处理。

**预处理管线**（由 CLI 自动编排，产物位于 `.molio/wiki-build/normalized`）：
- **docling 输出**：PDF/DOCX/PPTX 等非文本源文件经 docling 转换为结构化 Markdown
- **文本标题/窗口分块**：纯文本源文件按标题层级或固定窗口切分为可检索的块
- **JSON 流式策略**：超长文件以 JSONL 格式逐块流式处理，避免单次上下文溢出

**判断是否超长**：
```bash
wc -m 源文件          # 中文 1 字 ≈ 1.5 token，token ≈ 字符数 × 1.5
```
若 token 数 > 当前上下文的 30%，或 Read 工具一次读不完（默认上限 2000 行），即为超长。

## 操作步骤（递归 Wiki 入库流程）

1. **读取源文件**：读取目标源文件/资料，理解其内容。**超长文件走预处理管线**
2. **预处理源文件**：运行 `node "<wiki-build-skill>/scripts/wiki-build.mjs" scan --include "<source-path>" --content-hash --json`，获取源文件的 content hash 和预处理结果
3. **检测 wiki 布局**：读取 `wiki/INDEX.md`，判断是递归主题布局还是 legacy 扁平布局
4. **逐级读取 INDEX 定位目标主题**：
   - 读取根 `wiki/INDEX.md`，找到与源文件内容最相关的顶层主题
   - 逐级读取子主题 INDEX（`wiki/<topic>/INDEX.md`），向下导航到叶主题
   - 向用户建议目标叶主题，并说明选择理由
5. **用户确认或调整主题**：
   - 用户可以接受建议、选择其他已有主题、或创建新的单文件语义主题
   - 新建主题时，创建对应的 INDEX.md 和目录结构
6. **创建/更新页面**：
   - 在目标叶主题目录下创建 source 摘要页和相关知识页面
   - 新页面必须带完整 frontmatter 和 [[wiki 链接]]
   - 如果新内容改变了主题全局认知，更新该主题的 overview 页面（如果存在）
7. **反向更新交叉链接**：如果新页面与已有页面相关，在已有页面中也添加 [[wiki 链接]]
8. **矛盾处理**：如果新信息与已有 wiki 内容冲突：
   - 在两个页面中都添加 `> [!contradiction]` callout 标注
   - 说明矛盾的具体内容和可能的解决方向
   - 告知用户
9. **运行 reindex 更新索引**：运行 `reindex --topic-id "<leaf-topic-id>" --input "<ingest-manifest>" --summaries "<summaries-path>" --json`，CLI 会自动更新叶主题 INDEX（或分片）以及所有祖先 INDEX
10. **不要重建无关主题**：只更新受影响的叶主题及其祖先链路，不触及其他主题
11. **追加 wiki/log.md**（最新条目在最上面）：
    ```
    ## YYYY-MM-DD HH:MM | ingest | 文件名
    - 目标主题：<topic-path>
    - 创建页面数：N
    - 更新页面数：N
    - 关键发现：一句话概述
    ```
12. **刷新 wiki/hot.md**：完全重写，包含本次操作的摘要和当前 wiki 状态
13. **汇报**：创建和更新了哪些页面，目标主题是什么，发现了哪些矛盾或知识缺口

## 建页粒度

按**内容能否支撑独立页面**判断建页粒度（不靠频率百分比或绝对次数——不同长度/领域的源文件频率分布差异大，阈值会失真）：

应建独立页（任一满足）：
- 出现在章节标题/目录中（强信号，必有内容可写）
- 能用 `grep -nF 名字` 取到足够上下文写出有实质内容的独立描述（首次出现 + 身份归属 + 至少一个关键事件/关系）

只有零星提及（如"某某点头""某某路过"，grep 取证写不出实质内容）→ 放概念页表格行，不独立建页。

不同源文件的粒度不同，按各自内容特征独立判断。

## 入库页面规则

- 默认使用单文件页面。**文件名 = 实体/概念的规范名本身**：中文内容用中文名直做文件名（如 `wiki/<topic>/李白.md`），英文内容用 kebab-case（如 `wiki/<topic>/molio.md`）。`[[wiki 链接]]` 的链接名必须与目标文件名（去掉 `.md`）完全一致——`[[李白]]` 对应 `李白.md`，写成 `libai.md` 会断链。
- 只有当某个实体、项目或主题需要拆成多个稳定页面时，才建立同名目录，并用 `index.md` 作为该目录入口。
- 新页面必须包含完整 frontmatter，并与相关页面建立 [[wiki 链接]]。
- 新信息与已有 wiki 内容冲突时，明确标注矛盾并告知用户。
- **源文件不可变**：原始资料只能读取，绝不修改或移动。

如果新内容与现有 wiki 页面存在矛盾，在两个页面中都要明确标注，并告知用户。
