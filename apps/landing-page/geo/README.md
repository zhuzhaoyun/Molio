# GEO 优化方案（Molio.cn）

> GEO = Generative Engine Optimization，生成式引擎优化。
> 目标：让 Kimi、豆包、DeepSeek、元宝、ChatGPT、Perplexity 等 AI 大模型能「看到、理解、引用」Molio 的内容。

## 这个文件夹是什么

针对 AI 大模型（而非传统搜索引擎）的优化工作区。传统 SEO（百度/Google 收录、推送）解决的是「被搜索引擎收录」，GEO 解决的是「被 AI 大模型引用」。两者是上下层关系：

```
用户问 AI「红楼梦人物关系图谱」
        ↓ AI 联网搜索
        ↓ 底层调搜索引擎 / AI 爬虫
        ↓ 搜索引擎里得先有 molio.cn（这是 SEO 管的事）
        ↓ 内容足够结构化、可引用（这是 GEO 管的事）
        ↓ 被 AI 引用、总结、推荐
```

## 文件清单与用途

| 文件 | 类型 | 说明 |
|---|---|---|
| `geo-strategy.md` | 方案文档 | 完整 GEO 策略：诊断、原理、执行清单 |
| `../llms.txt`（根目录） | **可部署，已就位** | 给 AI 看的站点说明书，部署时随根目录直接发布 |
| `../robots.txt`（根目录） | **可部署，已就位** | 显式放行 AI 爬虫的完整版，已替换根目录旧版 |
| `data/keywords.md` | 数据 | 关键词机会与搜索意图调研 |
| `data/competitors.md` | 数据 | 竞品格局与外链/背书目标 |
| `snippets/structured-data.md` | 片段 | Product / FAQ / Breadcrumb 等 JSON-LD 片段 |

> `llms.txt` 和 `robots.txt` 直接放在 landing-page **根目录**（nginx serve 的就是该目录），打包发布时自动带上，无需拷贝。本 `geo/` 文件夹只放方案与数据，不会被部署。

## 上线部署步骤（按顺序）

1. **llms.txt / robots.txt 已就位**
   部署后验证：
   - `https://molio.cn/llms.txt` 应能看到纯文本内容
   - `https://molio.cn/robots.txt` 应能看到显式的 AI 爬虫放行规则

2. **结构化数据嵌入**
   把 `snippets/structured-data.md` 里的 JSON-LD 片段，按页面类型嵌入对应 HTML 的 `<head>`：
   - `index.html` → Organization + SoftwareApplication
   - `resources.html` → ItemList（商品列表）
   - `resource.html`（商品详情）→ Product + FAQ + Breadcrumb（配合 SSR 方案一起上）

## 依赖关系（关键认知）

- **GEO 依赖 SEO**：AI 大模型没有独立的爬虫索引，它联网搜索时底层仍在调搜索引擎。所以 `llms.txt` + robots 放行只是「让 AI 能读懂你」，**前提仍是内容先被搜索引擎收录**（这是前面 SEO 方案在解决的）。
- **先做 SSR，再做 GEO**：商品详情页 `resource.html?id=xx` 目前是 JS 空壳，AI 爬虫抓到的 HTML 里没有商品内容。GEO 的结构化数据必须在「服务端渲染出真实商品内容」之后才有意义。
