# Molio 全站 SEO 优化策略（重点：资源模块）

> 目标：提升搜索引擎自然流量，让「资源」（结构化知识图谱商品）在用户检索时能被找到。
> 面向引擎：百度（主）、Google、必应，以及 Kimi/豆包/DeepSeek/ChatGPT 等 AI 引擎（GEO）。
> 日期：2026-09-03

---

## 一、现状诊断（已核查代码）

### 1.1 已经做对的（保持，不要回退）

| 项 | 现状 | 位置 |
|---|---|---|
| 商品详情页 SSR | `/resource/{id}.html` 服务端渲染，正文/价格/元信息零 JS 可读 | `apps/cloud/src/ssr/render.ts` |
| Product + Breadcrumb JSON-LD | 详情页已嵌入，价格 `offers.price` 会显示在富摘要 | 同上 `productJsonLd` |
| 动态商品 sitemap | `/sitemap-products.xml` 实时拼全部在售商品 | `routes.ts` |
| sitemap 索引 | `sitemap.xml` → 静态 + 商品两个子 sitemap | `apps/landing-page/sitemap.xml` |
| llms.txt（GEO） | 动态生成，资源重心定位，AI 可直接读 | `renderLlmsTxt` |
| robots.txt | 显式放行 GPTBot/ClaudeBot/Bytespider 等 AI 爬虫 | `robots.txt` |
| 首页结构化数据 | Organization + WebSite + SoftwareApplication | `index.html` |
| canonical / OG / Twitter | 各页齐全 | 各 html |
| 数据埋点 | GA4 + 百度统计 | 各页 |
| 博客内容 | 覆盖 Obsidian 替代、Claude Code GUI、本地知识库等工具词 | `blog/` |

### 1.2 关键缺口（按影响排序）

| # | 缺口 | 影响 | 严重度 |
|---|---|---|---|
| 1 | **资源列表页 `resources.html` 是纯 JS 渲染**——HTML 里 `<div id="res-grid">` 是空壳，商品全靠 `fetch('/market/listings')` 前端拉取 | 百度（弱 JS 渲染）抓到的是一张空页；GPTBot/ClaudeBot 等 AI 爬虫不执行 JS，看到 0 个商品；列表页没有内链指向详情页，权重不流动 | 🔴 P0 |
| 2 | 列表页**缺 ItemList JSON-LD**，也没有任何商品文字/内链 | 无法进入富摘要，AI 无法从列表页提取商品清单 | 🔴 P0 |
| 3 | **未做百度站长平台验证 + 主动推送** | 新站百度收录慢，商品页不推送基本靠等 | 🟠 P1 |
| 4 | 未做 Google Search Console 验证 | 无法提交 sitemap、看不到索引覆盖与搜索词数据 | 🟠 P1 |
| 5 | `www.molio.cn` 与 `molio.cn` 并存，无 301 归一 | 主机重复，权重分散（canonical 只能缓解，不能根治） | 🟡 P2 |
| 6 | 详情页 `<title>` 用 `|` 分隔、列表页标题未命中商品类关键词 | 标题点击率与相关性可再优化 | 🟡 P2 |
| 7 | 商品详情页缺 FAQ（结构化问答） | 无法争取 People Also Ask / AI 引用 | 🟠 P1 |

---

## 二、核心结论（一句话）

**商品详情页的收录链路已经打通，真正卡住「资源」的是列表页——它是爬虫眼里的空壳。** 让 `resources.html` 也走服务端渲染（与详情页同款方案），是性价比最高、直接命中「资源能被搜到」这一目标的第一刀。其余（百度推送、站长验证、FAQ、外链）是第二、第三刀。

---

## 三、优先级路线图

### P0 —— 立即做（1-2 天，本次已落地第 1 项）

1. **资源列表页 SSR**（本次已实现）
   - `render.ts` 新增 `renderListingPage` + `itemListJsonLd`，服务端输出全部商品卡片 + 内链到详情页 + ItemList 结构化数据。
   - `routes.ts` 新增 `/resources.html` 路由；nginx 增加 `location = /resources.html` 反代。
   - 效果：百度、Google、AI 爬虫看到的不再是空壳，而是「每个商品名 + 简介 + 价格 + 详情页链接」。

2. **商品详情页补 FAQ（FAQPage JSON-LD + 可见 Q&A）**
   - 每个商品页加 3-5 个 FAQ（怎么导入 / 能查什么 / 和免费数据集的区别 / 支持退款吗）。
   - FAQ 是 AI 最爱引用的结构，也是 People Also Ask 的入口。

### P1 —— 本周到两周

3. **百度站长平台（ziyuan.baidu.com）**
   - 提交站点验证（加 `baidu-site-verification` meta，或上传校验文件到 landing-page 根目录）。
   - 提交 `sitemap.xml`。
   - 接「普通收录主动推送 API」：每次新商品上架时，在 cloud 的确认流程里 push 一次商品详情页 URL（也 push `/resources.html`）。这一步对百度尤其关键——百度对新站/新 URL 的抓取偏保守。

4. **Google Search Console**
   - 验证站点（推荐 DNS 验证，或 `google-site-verification` meta）。
   - 提交 sitemap；持续盯「网页索引」「体验（Core Web Vitals）」两个报告。

5. **商品 `<title>` 优化**
   - 详情页现在：`《名称》 — 知识图谱下载 | Molio`，可保留，但商品名若含关键词（如「红楼梦人物关系图谱」）已足够；避免超 32 个中文字符被截断。
   - 列表页 title 建议改为命中商品类词 + 品牌：如 `知识图谱资源库 — 红楼梦人物关系图谱、资治通鉴知识体系 | Molio 墨流`。

6. **补 hreflang/多语言不是当前重点**（单中文站可跳过），但补 `<meta name="baidu-site-verification">` 与 `google-site-verification`。

### P2 —— 一个月内

7. **`www` → 非 `www` 301 归一**：nginx `server_name` 里对 `www.molio.cn` 单独 301 到 `https://molio.cn$request_uri`，消除主机重复。

8. **内链加固**：博客文章正文里，凡提到「红楼梦」「资治通鉴」「知识图谱」处，链接到对应商品详情页（锚文本用商品名）；列表页是天然的内链枢纽，SSR 后每条卡片已含「查看详情」链接。

9. **外链 / 背书**（延续已有 GEO 计划）：HelloGitHub 投稿、openkg 收录、toolchase 提交、GitHub README 强化；每周 1 篇覆盖蓝海词的博客。

---

## 四、资源模块专项（本次重点）

### 4.1 为什么资源模块最该先修

- 详情页 `/resource/{id}.html` 已被 sitemap 收录、已 SSR，但**没有任何站内页面批量链接到它们**（列表页是空壳，无法传递权重与提供发现路径）。
- 列表页本身承载「红楼梦人物关系图谱」「资治通鉴知识图谱」等高意图商业词，却对爬虫不可见。

### 4.2 修好之后的结构（目标态）

```
/resources.html  (SSR，服务端输出全部商品卡片 + ItemList JSON-LD)
    ├── /resource/红楼梦图谱.html   (SSR，Product JSON-LD + FAQ)
    ├── /resource/资治通鉴.html     (SSR，Product JSON-LD + FAQ)
    └── /resource/妇产超声.html     (SSR，Product JSON-LD + FAQ)
        └── 每条互链「相关资源」6 条（已实现）
```

### 4.3 关键词覆盖（延续 `geo/data/keywords.md` 调研）

| 商品 | 目标词 | 意图 | 落点 |
|---|---|---|---|
| 红楼梦人物关系图谱 | 红楼梦人物关系图 / 图谱 | 商业（想直接拿成品） | 详情页 H1 + FAQ |
| 资治通鉴知识体系 | 资治通鉴知识图谱 / 体系 | 商业 | 详情页 H1 + FAQ |
| 妇产超声知识体系 | 妇产超声知识体系 / 图谱 | 商业（付费意愿强） | 详情页 + 独立落地页 |
| 知识工程全景图谱 | 知识图谱 / GraphRAG / 知识工程 | 信息+商业 | 详情页 + 博客导流 |

命名规范（沿用已有结论）：`《主题》知识图谱 | 可导入 Molio/AI 的结构化知识库`。

---

## 五、技术 SEO 清单（验证项）

- [ ] 百度/Google 站长验证通过
- [ ] `sitemap.xml` + `sitemap-products.xml` 均提交，索引覆盖比（收录数 / 提交数）> 80%
- [ ] `resources.html` 返回 HTML 内含商品名（`curl https://molio.cn/resources.html | grep 红楼梦`）
- [ ] Core Web Vitals：LCP < 2.5s、INP < 200ms、CLS < 0.1（列表页 SSR 后首屏更快）
- [ ] 无 404、无死链、无 5xx（cloud 已有「降级 404/空 sitemap」容错，保持）
- [ ] `robots.txt` 未误挡 AI 爬虫；`llms.txt` 可访问

---

## 六、效果验证与归因

| 指标 | 怎么测 | 目标（12 周） |
|---|---|---|
| 收录 | 百度站长/Google GSC 的索引覆盖 | 商品页收录率 > 80% |
| 排名 | 每周盯「红楼梦人物关系图谱」「资治通鉴知识图谱」等词 | 3 个蓝海词进 Top 10 |
| 流量 | GSC + 百度统计，拆分品牌词 / 非品牌词 | 非品牌自然流量同比增长 |
| 转化 | 资源详情页「购买/下载」点击 → 支付 | 详情页流量转化率 > 3% |
| AI 引用 | 在 Kimi/豆包/DeepSeek 问目标词，看是否提到 Molio | 至少 1 个词被 AI 引用 |

> 归因口径：SEO 是复利，2-4 周看到收录变化，8-12 周看到排名与流量变化。不要以天为单位判断效果。

---

## 七、本次已落地的改动（代码）

1. `apps/cloud/src/ssr/render.ts` — 新增 `itemListJsonLd`（ItemList 结构化数据）与 `renderListingPage`（服务端输出全部商品卡片 + 内链）。
2. `apps/cloud/src/ssr/routes.ts` — 新增 `GET /resources.html`，缓存 `public, max-age=3600`，市场数据异常时降级为空态（不 5xx）。
3. `apps/landing-page/molio.conf` — 新增 `location = /resources.html` 反代到 cloud SSR。
4. `apps/cloud/test/ssr-routes.test.ts` — 新增列表页 SSR 用例（SEO 要素 / XSS 转义 / ItemList 内容 / 空态）。
