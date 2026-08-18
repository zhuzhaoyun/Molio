# wiki-build / wiki-ingest 长文档处理整体重构方案

> 状态：方案稿（未实施）· 基于三库存量库实证（红楼-test / 史记-test / 明史）
> 日期：2026-08-16

## 一、背景：三库暴露的现状与问题

三个长文档知识库用三种不同方式构建，暴露了三套离散能力，**没有任何一个库同时做对三件事**：

| 能力 | 红楼-test | 史记-test | 明史 | 说明 |
|---|---|---|---|---|
| 类型分发 | ❌ 全 entity | ❌ 全 entity 塌缩 | ✅ 批次带 cat + 页类 | 史记把「春秋」「匈奴」全压成实体 stub |
| 链接对账门禁 | ✅ deadcheck 0 | ✅ 0 死链 | ❌ **187 死链** | 明史没跑 deadcheck/linkpass |
| 粒度控制 | ❌ 519 stub 过度 | ❌ 引文噪音 686 | ✅ 337 页克制 | 红楼梦建了大量背景挂点 stub |

**根因**：同一根问题（超长文本建 wiki）被三次分别解决，方案碎片化：

1. **红楼-test**：1.9.0 产品化脚本（本次 PR#220 的 10 脚本）—— 对账完备但单类型、清单繁琐
2. **史记-test**：同 1.9.0 脚本 —— 类型塌缩、引文噪音未分类
3. **明史**：Workflow 编排（wf-page.js）+ 批次 TSV（带类别列）+ 自写 verify 脚本 —— 类型分发干净、粒度克制，但零对账门禁

## 二、明史反推：什么值得吸收

明史的所有能力都集中在**批次 TSV 这一个数据结构**里：

```tsv
# cat=帝系
# 每行五列，制表符分隔：
#   名字 | 一句话定性（含出处断言） | 别名（逗号分隔） | 证据行号（transcode 行号） | 页类
朱元璋（明太祖）	明朝开国皇帝，定都金陵、革行省置十三布政司（count 4）	别名: 太祖/高皇帝/上/吴国公	证据行号: 4739,8707,11071,11953	页类: entity
朱允炆	明惠帝·建文帝·太祖之孙…	别名: 惠帝/建文/帝	证据行号: 324,406,24847	页类: entity
```

**关键设计（三个结构性质，非实现细节）**：

1. **批次即清单，无中间层**。从 census → entity-master.tsv（3434 行全量）→ curation 筛 355 条 → 批次 TSV。**没有 manifest 冻结、没有 merge-master、没有 alias-table 三层清单**（别名直接写进批次每行，天然消歧：`别名: 成祖/文皇帝/上` 一行解决）。
2. **类型在批次层声明，不在建页时猜**。`# cat=帝系/后妃/.../概念与制度页` + 每行 `页类: concept/entity` → 建页 agent 的 prompt 直接 "概念→concept 否则 entity"。史记的类型塌缩**在结构上不可能发生**。
3. **证据行号预置**。每行自带 `证据行号: 4739,8707` → 建页 agent 不需要全文 grep 找首现，直接看指定行 → 更高频名取证封顶自动生效、引文直接指向 transcode 行号，verify 命中率大幅提升。

**明史缺失的部分**（不可吸收，需补）：
- ❌ 没有 deadcheck/linkpass → 187 死链带病交付（庙号「明世宗→朱厚熜」没进别名、赵南星等真缺页）
- ❌ 没有 build-lock → 无并发保护
- ❌ 引文核验是自写 fix-quotes*.mjs 多轮 + 手动，靠 agent 认真

## 三、重构目标：合并三库长处为一条管线

```
┌─ prep.mjs（保留，唯一不可替代的地基）
│    转码/分段/census/candidates → transcode行号 稳定可 grep
│
├─ curation（信息落点判据环节 → 批次 TSV）
│    census rows（count/ranges/lines）→ entity-master 全量候选
│    → 主 agent 按「信息落点判据」筛出候选集、按主题分批、
│      每行补: 定性 | 别名 | 证据行号 | 页类  → batches/*.tsv
│    【替代 merge-master + alias-table + manifest 三层】
│
├─ 建页（每批一个 subagent / Workflow）
│    读批次 TSV 该批行 → grep 证据行号 → 写 drafts/<名字>.md
│    prompt 按 页类 给模板（concept 模板 / entity 模板）
│    【替代 batcher 分片 + build 建页 prompt 模板】
│
├─ place.mjs（保留，改造）
│    按批次 TSV 的 页类 分发 → wiki/entities/ 或 wiki/concepts/
│    INDEX 追加（ingest 场景）或全量重写（build 场景）
│    【替代 place 单类型分发，加 --append 增量模式】
│
├─ 对账门禁（保留，从 1.9.0 吸收）
│    linkpass.mjs 补漏链（用批次 TSV 的别名列，直接消庙号死链）
│    deadcheck.mjs 死链门禁 exit 0
│    build-lock.mjs 并发锁
│
└─ 引文核验（保留，从 1.9.0 吸收 + 分类）
     sweep.mjs 全量 verify → 分类: 真错/blockquote噪音/PUA转码差异
     repair.mjs 按 rules.json 修复（双份 wiki+drafts）
     【明史的 fix-quotes 自写脚本不再需要】
```

## 四、合并/保留/废弃清单

### 保留（原样或小改）
| 组件 | 理由 |
|---|---|
| `prep.mjs` | 确定性地基，三库都复用，唯一不可替代 |
| `deadcheck.mjs` | 明史 187 死链证明必须（别名校验增强：目标页不存在 → 死链） |
| `linkpass.mjs` | 用批次别名列，庙号死链自动消解 |
| `build-lock.mjs` | 并发保护（label 所有权，修复过） |
| `sweep.mjs` + `repair.mjs` | 引文逐字节核验 + 双份修复（新增 missing 分类：真错/blockquote/PUA） |
| 信息落点判据（SKILL.md「建页粒度」节） | 领域无关，已在 1.9.0 落地 |

### 合并（两套合一，消除重复逻辑）
| 现有 | 去向 |
|---|---|
| `batcher.mjs`（1.9.0 分片） | 并入 curation：批次 = 主 agent 的 curation 产物，脚本只做「TSV 格式校验 + 分批计数」 |
| `place.mjs 单类型分发` | 改造为按批 TSV `页类` 分发 + `--append` 增量模式 |
| `alias-table.mjs`（1.9.0） | 合并进批次 TSV 的 `别名` 列（一行自带），不再单列推导脚本 |
| 明史 wf-page*.mjs 自写模板 | 沉淀为 SKILL.md 的 L2b 建页 prompt 模板（concept/entity 两版） |

### 废弃（文档化后移除或降级为参考）
| 组件 | 废弃原因 |
|---|---|
| `merge-master.mjs`（1.9.0 确定性合并） | 被 curation 替代——跨 digest 合并的「同名异人仲裁」本就是 agent 审核环节，脚本化反而制造 4 处误并（史记复盘坑 3） |
| `page-manifest-<x>.md` 冻结清单 | 被批次 TSV 替代——清单在批次层已经冻结，再建 manifest 是重复 |
| `checkoff.mjs`（G1/G2 门禁） | G1（master 覆盖 manifest）随 manifest 废弃；G2（页面齐全）改为「批次 TSV vs drafts 落盘对账」（明史靠这个发现 batch 09 缺 8 篇——这是最有价值的核对） |
| `orphan-audit.mjs` | 降级为 lint 能力（wiki-lint 已引用），不属于构建管线 |
| `fixfront.mjs` | 合并进 place（frontmatter 清洗在安置时做一次） |

## 五、Skill 分界（重构后）

**wiki-build**：从零/全库构建 —— curation → 建页 → place 全量重写 INDEX → 对账门禁 → 引文核验。
**wiki-ingest**：增量入库 —— 复用 prep/census/curation 产出批次 TSV（只选与本次新内容相关的行）→ 建页 → **place --append 追加 INDEX**（保留方案 A 的增量语义，不重写既有索引）→ 对账 → 引文核验。
**wiki-lint**：健康检查 —— orphan-audit / deadcheck 只读报告，不动构建。

## 六、重构的直接效益

1. **类型塌缩从结构上不可能**（史记病根绝）—— 批次行声明 `页类`
2. **庙号/别名死链自动消解**（明史病根绝）—— 批量行 `别名: 成祖/文皇帝` 直接被 linkpass 用
3. **删除 3 个脚本、合并 2 个**（merge-master / manifest / alias-table；batcher / place）—— 状态面变小，回归面更可控
4. **粒度控制回归 agent**（红楼梦 519 stub 病根）—— curation 就是信息落点的 agent 审核环节，过度建页不再由管线自动制造
5. **引文核验带分类**（史记 686 噪音病根）—— sweep 输出真错/噪音分离

## 七、实施顺序（建议）

1. **批 TSV 格式定义 + curation 脚本**（校验 TSV、计数、按 cat 分组）—— 一次性替换 manifest/batcher/merge-master/alias-table
2. **place.py 加页类分发 + --append** —— 替换单类型 place
3. **linkpass 改用批次别名列** —— 消庙号死链
4. **sweep 加 missing 分类** —— 把噪音从真错分离
5. **SKILL.md 重写超长管线段落**（build/ingest 共用一套）—— 版本 bump 2.0.0
6. **三库回归验证** —— 明史（对账补齐）/ 史记（类型分发重跑）/ 红楼（粒度控制）

## 八、开放问题

- **curation 模式**：✅ 已定——脚本预填 + agent 审核。脚本做机械映射（count 排序/分批/行号/别名预填），agent 只审语义判断（建不建/属哪个 cat/页类）。
- **批次规模**：✅ 已定——留白为主 + 脚本兜底。curation agent 按主题分批（`# cat=` 即类型标签），脚本硬规则：单批超 15 条自动拆分，防上下文爆炸。
- **`页类` 值域**：✅ 已定——仅 entity/concept。source/overview/comparison 生成时机不同，不进批次 TSV。