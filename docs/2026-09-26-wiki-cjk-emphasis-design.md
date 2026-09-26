# wiki 技能 CJK 加粗失效防护 —— 行为说明

> 对应：分支 `feat/wiki-cjk-emphasis`。本文描述**本次改动的内容与设计取舍**，供维护和下次改动时查阅。

## 要解决的问题

排版预览里看到裸露的 `**`：源文写的是 `**生态位（萝卜坑）**的分配`，渲染出来加粗不生效、星号原样显示。

机理是 CommonMark 的 flanking 规则：闭合 `**` 前面是标点（括号、引号、逗号等）时，后面必须跟空白或标点才能闭合；后面跟的是普通文字（如「的」）就不认，两组 `**` 都按字面输出。这条规则本来是为了防止英文误伤（`a**b**c` 不应加粗），但中文没有空格，`（……）**的分配` 是非常自然的写法，所以特别容易踩到。开启侧同理：`**` 后面贴标点、前面紧贴汉字时（如 `甲**「重点」**乙`）连开启都失败。

注意 CommonMark 的「标点」不是只有 ASCII 标点，而是 Unicode 的 P + S 两个大类——`¥`、emoji、`→`、`★` 都算。渲染侧的 ground truth 是排版预览实际使用的 marked（v18，flanking 判定口径与规范一致）。

## 方案：生成侧提示 + 检查侧脚本，两条腿

**生成侧**（写的时候就不写坏）：wiki-build / wiki-ingest / wiki-save 三个会写 wiki 页面的 skill，核心原则里新增「加粗书写规范（CJK）」一条——加粗首尾紧贴文字；标点贴边时按失效侧补半角空格：闭合侧失效在闭合 `**` 后补（`**生态位（萝卜坑）** 的分配`），开启侧失效在开启 `**` 前补（`甲 **「重点」** 乙`），两侧都失效就两侧都补。只补一侧是不够的：双侧失效的写法只补闭合侧空格，开启侧依然失效（已用 marked 实测确认）。

**检查侧**（已写坏的能查出来）：新增确定性扫描脚本 `apps/daemon/src/tools/skills/wiki-build/scripts/cjk-emphasis-check.mjs`，wiki-lint 的检查方法 3 接入调用、检查清单新增第 14 项。脚本扫 vault 的 `wiki/` 目录，输出 JSON 报告（每条含文件、行号、失效侧 `side`、配对文本、上下文），恒 exit 0——它是报告工具不是门禁，vault 不存在、`wiki` 不是目录、单文件读失败都不崩。

既有 vault 不需要手动同步：skill-installer 按内容哈希把整棵 skill 目录（含 `scripts/`）镜像到 vault 的 `.claude/skills/`，新脚本随同步自动到位。wiki-\* 五件套版本号按约定共进 2.1.0 → 2.2.0。

## 备选方案评估：换宽容的 Markdown 渲染器（不采纳）

排查时评估过「换一个对中文更友好的解析器，从根本上解决」的思路，结论是不采纳，原因分两层。

**这不是 marked 的 bug，换谁都一样。** flanking 规则写在 CommonMark 规范里（[commonmark-spec#650](https://github.com/commonmark/commonmark-spec/issues/650)，2017 年提出至今未决），markdown-it、remark/micromark、GitHub、VS Code、Obsidian 等主流实现的行为完全一致，同样的症状在别家产品里原样出现（如 [Qwen Code 的 web 端](https://github.com/QwenLM/qwen-code/issues/9456)）。换成其中任何一个，`**生态位（萝卜坑）**的分配` 照样渲染出裸露星号。

**真正的根治方案在规范层，但 Molio 现在吃不到。** 社区有一份正在成型的修正案 [tats-u/markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly)：把 CJK 标点从 flanking 判定的「标点」类别里摘出来，对非 CJK 输入与原规范完全等价；已有 markdown-it / remark / Comrak / goldmark / Markdig 移植，被 VitePress（v2 起内置）、Docusaurus、Astro、[Redmine](https://www.redmine.org/issues/43234) 等采用。但对 Molio 有三个硬问题：

1. **没有 marked 移植**。排版引擎是 vendored doocs-md，整套微信导出 HTML 生成（内联样式、主题、脚注、TOC）建立在 marked API 上——要上 cjk-friendly 等于整体重写排版引擎，回归风险压在产品最核心的导出保真度上。
2. **预览会失真**。渲染器比 GitHub/Obsidian/VS Code 都宽容之后，排版预览显示加粗正常、源文贴到别处却裸露 `**`。排版工具的职责是「所见即目标平台所得」，比全世界都宽容的预览是负资产。
3. **省不掉源文规范**。Molio 的 markdown 会流出到外部规范实现，「写出来就在任何解析器下都正确」仍是最低标准——这正是本次生成侧提示 + 扫描脚本保障的东西。

因此本次选择治源文：修好的文本在 CommonMark 和 cjk-friendly 两种规则下都正确，流向任何平台都不破。若未来 marked 出现官方移植，或项目决定整体迁移排版引擎（独立大项目，需全量 E2E 护航），届时重新评估。

## 扫描脚本的关键取舍

- **标点判定用 Unicode P+S 全类**，与 CommonMark 0.31 / marked 同口径。只查 ASCII 标点会漏掉 `¥`/emoji 贴边；把汉字当标点又会全库误报。
- **边缘字符按码点取**（不是 UTF-16 码元）。加粗首尾是 emoji 时，按码元取会取到半个代理对，既不是标点也不是文字，直接漏判。
- **并列加粗豁免**：`**重点（关键点）**和**次重点**` 这种写法，前一个闭合 `**` 虽然 flanking 失败，但 CommonMark 的定界符栈会把它重新当作开启符、和后面的 `**` 配成嵌套加粗——实际渲染没有字面残留，不该报。脚本对「闭合失效但同段落后还有可闭合 `**`」的配对不报闭合侧（只报链尾无处可配的那对；修好链尾，整链即愈，marked 实测验证）。
- **跳过区间只在本脚本内增补**：frontmatter（容忍 BOM）、``` 与 ~~~ 围栏、缩进代码块、跨行等长反引号代码 span、`\` 转义、*** 粗斜体。共享库 `linktext.mjs` 的口径一个字没动——它同时服务 deadcheck/orphan-audit/linkpass，改它 blast radius 太大；本脚本自己算补充区间。
- **保守漏报优于误报**：lint 工具误报多了就没人看了。已知盲区显式列在脚本头注释里（配对内含单 `*` 不匹配、`MAX_PAIR_LEN=2000` 上限、`__` 下划线定界符不扫、闭合侧转义的归因偏差等）。

## 测试

`apps/daemon/test/tools/cjk-emphasis-check.test.ts`，42 个用例，每个用例独立临时 vault、spawnSync 驱动真实 CLI。覆盖：输出契约（字段集、截断、上下文窗口、fileCount 语义）、`side` 三态分类、S 类符号双向、emoji 码点边界、并列豁免与链尾报告、全部跳过区间及其邻接边界行号、守卫分支（转义/第三星/EOF 无换行）、CRLF 行号、跨文件排序。关键断言与 marked v18 的实际渲染结果逐一对齐过。
