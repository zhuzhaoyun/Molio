# Molio GEO 策略（生成式引擎优化）

> 让 Kimi、豆包、DeepSeek、元宝、ChatGPT、Perplexity 能「看到、理解、引用」Molio。

## 一、为什么单独做 GEO，而不只是 SEO

传统 SEO 优化的是「被搜索引擎收录、排名」，让用户点进网页。
GEO 优化的是「被 AI 大模型引用、总结、推荐」，让用户在 AI 对话里听到 Molio。

关键机制差异：

| 维度 | SEO（百度/Google） | GEO（AI 大模型） |
|---|---|---|
| 入口 | 搜索结果页，用户点击 | AI 对话，AI 引用后用户看到 |
| 收录方式 | 爬虫 + 索引库 + 推送 | 联网搜索时临时调搜索引擎/爬虫 |
| 能否主动推送 | 能（百度主动推送、Google Indexing API） | **不能**，无推送接口 |
| 优化手段 | 关键词、内链、外链、技术 SEO | llms.txt、robots 放行、结构化数据、可引用内容 |

**核心结论**：AI 大模型没有自己的独立索引，它联网搜索时底层仍在调搜索引擎。所以：
1. 先让内容被搜索引擎收录（SEO，前置条件）
2. 再让内容结构化、可被 AI 干净提取和引用（GEO，本文件重点）

## 二、Molio 现状诊断

| 项 | 现状 | 问题 |
|---|---|---|
| robots.txt | `User-agent: *` 全放行 | AI 爬虫默认能抓，但**未显式声明** |
| llms.txt | 无 | AI 没有「站点说明书」，只能从 HTML 乱猜 |
| 商品详情页 | JS 空壳，HTML 里 0 商品文字 | AI 爬虫抓不到商品内容 |
| 结构化数据 | 首页/resources 无 JSON-LD | AI 提取信息困难 |
| 品牌词 | 「Molio」「墨流」 | 需强化，AI 引用时靠品牌词锚定 |

## 三、执行清单（按优先级）

### P0 —— 让 AI 能抓到（先做）

1. **上线 llms.txt**（本文件夹已备好）
   - 放到 landing-page 根目录，`https://molio.cn/llms.txt` 可访问。
   - 这是 AI 的第一入口：告诉它「我是谁、有哪些内容页、怎么定位」。

2. **robots.txt 显式放行 AI 爬虫**（本文件夹已备好）
   - 显式声明 GPTBot / ClaudeBot / PerplexityBot / Bytespider / MoonshotBot / Google-Extended。
   - 防止未来误加 `Disallow` 时把 AI 爬虫也挡在外面。

3. **商品详情页 SSR**（配合前面的 SEO 方案）
   - 让 `resource.html?id=xx` 的 HTML 里直接带商品名、简介、价格。
   - 否则 AI 爬虫和搜索引擎都抓到空壳，llms.txt 再全也没用。

### P1 —— 让 AI 读得懂（结构化）

4. **嵌入 JSON-LD 结构化数据**（片段见 `snippets/structured-data.md`）
   - Organization + SoftwareApplication（首页）
   - ItemList（资源市场列表页）
   - Product + FAQ + Breadcrumb（商品详情页）
   - 作用：AI 能干净提取「商品名/价格/介绍」，而不是从 HTML 里乱猜。

5. **每篇内容都带清晰的 FAQ 区块**
   - AI 大模型特别爱引用 FAQ（一问一答，结构天然适合被摘录）。
   - 商品页、帮助页、博客结尾都加 3-5 个 FAQ。

### P2 —— 让 AI 愿意引用（可引用性）

6. **强化品牌词锚定**
   - 内容里统一用「Molio（墨流）」全称，AI 引用时能锚定到你的品牌。
   - 首页 H1、商品介绍、博客标题都要有品牌词。

7. **做「AI 无法凭空生成的独特内容」**
   - AI 引用偏好权威、独特、被反复引用的内容。
   - Molio 的护城河：**结构化的知识图谱商品**（红楼梦人物关系图谱、妇产超声知识体系、资治通鉴知识体系）。这类「人做出来、AI 现搜不到现成结构」的内容，最容易被 AI 当答案引用。

8. **权威背书 + 外链**
   - HelloGitHub 收录、openkg（开放知识图谱社区）、toolchase 等工具站收录。
   - 开源项目主页 + GitHub stars 是 AI 判断「可信度」的强信号。

## 四、GEO 效果怎么验证

| 验证方式 | 操作 |
|---|---|
| 直接问 AI | 在 Kimi/豆包/DeepSeek 里问「红楼梦人物关系图谱 下载」，看是否提到 Molio |
| 检查 llms.txt | `curl https://molio.cn/llms.txt` 确认可访问、内容正确 |
| 检查抓取日志 | 看 nginx access log 里是否出现 GPTBot / ClaudeBot / Bytespider 的 UA |
| 搜索引擎收录 | 先确认百度/Google 已收录商品页（GEO 的前置） |

## 五、长期维护

- 每次新增商品，同步更新 `llms.txt` 的「知识资源市场」部分（或让它从云端市场动态生成）。
- 每篇新博客发布后，加入 `llms.txt` 的博客列表。
- 定期在 AI 里问一轮目标词，记录「是否被引用」，作为 GEO 效果的长期追踪指标。
