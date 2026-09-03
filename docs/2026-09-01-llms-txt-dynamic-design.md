# llms.txt 动态化 + 资源重心重构

> 状态：待开发（Claude Code 按本文档实现）
> 关联：`docs/2026-09-01-ssr-product-pages-design.md`（同一 SSR 服务）

## 一、背景：两个问题

1. **商品动态更新，不能写死**。llms.txt 若写死商品清单，每天随机上新就会过期，AI 读不到新商品。
2. **宣传重心错位**。当前 llms.txt 以「Molio 软件」为主角，但真实商业模型是：
   - Molio 软件 = **免费开源**（获客工具 / 资源的阅读器，不直接变现）
   - 知识图谱资源 = **付费**（真正的营收来源）

用户搜的是「红楼梦人物关系图谱」「妇产超声知识体系」，不是「Molio」。所以 llms.txt 必须**以资源为主体，Molio 降级为免费载体**。

## 二、方案

把 `/llms.txt` 从「静态文件」改为「运行时动态生成」，与已上线的 `/sitemap-products.xml` 完全对称：

```
爬虫请求 https://molio.cn/llms.txt
        ↓ nginx location = /llms.txt 反代
auth.molio.cn（apps/cloud SSR 服务）
        ↓ service.list() 实时拉全部在售商品
        ↓ renderLlmsTxt(listings) 拼 Markdown 文本
返回 text/plain
```

新商品上架 → `service.list()` 更新 → `/llms.txt` 自动更新 → AI 下次抓取即读到。零手工维护。

## 三、改动点（3 处，全部在现有 SSR 服务内）

### 1. `apps/cloud/src/ssr/render.ts` —— 新增 `renderLlmsTxt`

```ts
export function renderLlmsTxt(listings: MarketListing[]): string
```

- 输出纯文本 Markdown，格式见「第四节模板」。
- 排序：`[...listings].sort((a, b) => a.priceCents - b.priceCents)` —— 免费款自动排前，付费款按价格升序。
- 摘要截断：复用现有 `metaDescription(summary, 60)`。
- 价格格式化：复用 `formatPriceYuan`（当前是模块私有函数，需在同文件内直接调用即可，无需导出）。
- 链接：复用 `productUrl(id)`。
- 安全：所有 name/summary 经 `escapeHtml` 转义（与商品页同一约定）。

### 2. `apps/cloud/src/ssr/routes.ts` —— 新增 `/llms.txt` 路由

在 `ssrRoutes` 内，与 `/sitemap-products.xml` 并列加一条：

```ts
app.get('/llms.txt', async (c) => {
  let listings: Awaited<ReturnType<MarketService['list']>> = [];
  try {
    listings = await deps.service.list();
  } catch (e) {
    console.error('[cloud] ssr llms.txt error:', e);
  }
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', SITEMAP_CACHE); // public, max-age=600
  return c.body(renderLlmsTxt(listings));
});
```

### 3. `apps/landing-page/molio.conf` —— 新增反代规则

与 `/sitemap-products.xml` 的 location 块并列加：

```nginx
# 动态 llms.txt（给 AI 爬虫/大模型读，商品清单实时）
location = /llms.txt {
    proxy_pass https://auth.molio.cn;
    proxy_ssl_server_name on;
    proxy_set_header Host auth.molio.cn;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
}
```

### 4. 静态文件处置

`apps/landing-page/llms.txt` 静态文件 **删除**（nginx `location = /llms.txt` 精确匹配已接管，静态文件不再生效）。

## 四、renderLlmsTxt 输出模板（资源重心）

以下为完整目标输出。`{{ }}` 部分由代码遍历填充，其余为固定文案。

```markdown
# Molio 墨流 · 知识图谱资源库

> 本站是「结构化知识图谱 / 知识体系」资源库。提供《红楼梦》人物关系图谱、《资治通鉴》知识体系、妇产超声知识图谱、知识工程全景图谱等，Markdown 格式，购买后可一键导入 Molio 或 Obsidian 等本地 AI 知识库。

## 本站卖什么

- **知识图谱资源（核心，付费）**：把经典著作 / 专业领域整理成结构化、可关联、可被 AI 问答引用的知识图谱，不是散乱资料堆。
- **Molio 软件（免费开源）**：本地优先的 AI 知识库 + 知识图谱桌面应用，是上述资源的阅读器与载体，永久免费。

## 与免费开源资源的区别

免费开源图谱（如 OpenKG、HonglouData）是「原始数据集」，需自行清洗、建关系、写导读；本站资源是「成品」——已结构化、带导读、可直接导入 AI 知识库做问答与联想。

## 在售资源

{{ 遍历 listings，按 priceCents 升序（免费在前）：
### 免费资源            ← 仅当存在 priceCents===0 的项时输出
- [名称](productUrl)：一句话摘要。
### 付费资源            ← 仅当存在 priceCents>0 的项时输出
- [名称](productUrl)：¥价格 — 一句话摘要。
}}

## 软件（免费）

- Molio 桌面端：本地 AI 知识库，免费开源（MIT），GitHub：https://github.com/zhuzhaoyun/Molio

## 核心页面

- [首页](https://molio.cn/)：产品介绍、下载入口。
- [资源市场](https://molio.cn/resources.html)：全部在售知识图谱资源。
- [使用指南](https://molio.cn/help.html)
- [博客](https://molio.cn/blog/index.html)

## 博客文章

- [Obsidian 替代方案](https://molio.cn/blog/obsidian-alternative.html)
- [Molio vs Obsidian 对比](https://molio.cn/blog/molio-vs-obsidian.html)
- [Claude Code 图形界面指南](https://molio.cn/blog/claude-code-gui-guide.html)
- [本地知识库搭建](https://molio.cn/blog/local-knowledge-base.html)

## 关键信息

- 品牌：Molio（墨流）；域名：molio.cn；源码：github.com/zhuzhaoyun/Molio。
- 商品格式：Markdown（.zip）；兼容：Molio / Obsidian。
- 购买：付费资源扫码支付后自动发货，下载链接 1 小时内有效；免费资源直接下载。
```

## 五、明确不做

- 不按「文学/哲学/医学/技术」手工分类 —— `tags` 字段是主题标签而非分类，自动分类会失真；如需分类，需在 `MarketListing` 增加 `category` 字段（另行设计）。
  - 2026-09-03 修订：不做的是「按商品归类」；固定「资源品类」概述文案保留（描述站点覆盖面，含本体论/语义网等关键概念），由 renderLlmsTxt 以固定文案块输出，与 tags 无关。
- 不改商品页 SSR 逻辑、不动支付流程、不动 `resources.html`。
- 不新增 `llms-full.txt` —— 商品量级（几十以内）单文件 `llms.txt` 足够。

## 六、验收标准

1. `curl https://molio.cn/llms.txt` 返回 200，`Content-Type: text/plain`。
2. 响应体含「知识图谱资源库」定位 + 全部在售商品名称与价格（免费款在前）。
3. 上架一个新商品后（无需重新部署 llms.txt），`curl https://molio.cn/llms.txt` 立即可见该商品。
4. 市场接口故障时返回合法但商品为空的 llms.txt（不 5xx）。
5. `apps/landing-page/llms.txt` 静态文件已删除。
