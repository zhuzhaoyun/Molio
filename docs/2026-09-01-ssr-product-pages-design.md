# 商品详情页 SSR 化设计与开发说明（SEO 基础设施）

> 日期：2026-09-01
> 状态：已开发（待部署上线；部署步骤见 §六）
> 目标读者：Claude Code / 开发者
> 前置阅读：`apps/landing-page/geo/README.md`（GEO/SEO 总体背景）

## 一、背景（为什么做这件事）

### 1.1 商业现状

- molio.cn 是 Molio（墨流）官网，静态站，部署在 nginx 上。
- 网站自然搜索流量不足，正在做全面 SEO 优化。
- **付费转化页是知识资源市场**：`https://molio.cn/resources.html` 列出商品，用户点进 `https://molio.cn/resource.html?id={id}` 查看商品详情并购买。
- 商品是**结构化知识图谱**（如「红楼梦人物关系图谱」），单件 ¥5.9–¥49.9，目标关键词竞争极低，是被低估的自然搜索流量来源。

### 1.2 商品供给方式（关键约束）

- 商品**每天随机上新，上架前无法预知是什么**。
- 商品数据不在前端、不在构建期，而是**运行时的活数据**，存放在云端市场服务 `auth.molio.cn`，通过 HTTP 接口提供：
  - `GET /market/listings` — 全量商品列表（JSON）
  - `GET /market/listings/{id}` — 单个商品详情（JSON）
  - 商品 JSON 包含：`id`（稳定 ULID）、`name`、`summary`（多行文本）、`priceCents`（分）、`tags`、`previews`（图片 URL 数组）、`author`、`version`、`publishedAt` 等字段。

### 1.3 问题（为什么现在的商品页对搜索引擎是隐形的）

当前商品详情页 `resource.html?id={id}` 是**纯客户端渲染（CSR）**：服务器返回的原始 HTML 只是一个带脚本的空壳，商品内容全靠浏览器执行 JS、再去 `auth.molio.cn` 拉数据后现场渲染。

后果：

- **百度爬虫不执行 JS**，抓到的原始 HTML 里没有任何商品文字 → 全部商品页无法被收录。
- Google 虽能延迟渲染，但收录慢、权重低。
- AI 大模型（Kimi、豆包等）联网检索时同样抓原始 HTML，抓不到商品内容 → GEO（让 AI 引用）也无从谈起。
- 所有商品共用一个 URL 路径 + 查询参数，搜索引擎视为同一页面，无法分别积累排名。
- 商品 URL 不在 sitemap 中，搜索引擎难以及时发现新商品。

### 1.4 已完成的前置工作（不用再做）

- `llms.txt` 已上线（`https://molio.cn/llms.txt` 返回 200）。
- `robots.txt` 新版已上线，显式放行 GPTBot / ClaudeBot / Bytespider / MoonshotBot / Google-Extended 等搜索引擎与 AI 爬虫。
- 首页 `index.html` 已有完整 JSON-LD（Organization / WebSite / SoftwareApplication）。
- GEO 方案与数据存放在 `apps/landing-page/geo/`（含关键词调研、竞品、结构化数据片段参考）。
- 百度/Google 推送的 GitHub Action 方案已另行设计（`.github` 级别，与本任务解耦）。

## 二、方案（做什么）

### 2.1 核心思路

**把商品详情页从「构建期/浏览器渲染」改为「请求时服务端渲染（SSR）」。**

任何人（爬虫或浏览器）访问商品页 URL 时，服务器现场拉取该商品的实时数据，拼出**含完整内容的 HTML** 返回。因为渲染发生在每次请求时，所以：

- 新商品上架的那一刻，它的页面就自动是完整可收录的——**零预知、零手工映射、零构建步骤**，永久解决「每天随机上新」与 SEO 的矛盾。

### 2.2 目标架构

```
爬虫 / 用户
    │ GET https://molio.cn/resource/{id}.html
    ▼
molio.cn 的 nginx（静态站，保持不变）
    │ 识别商品页路径 → 反向代理
    ▼
SSR 服务（新增，一个轻量 HTTP 服务）
    │ 调用 auth.molio.cn/market/listings/{id} 拉实时数据
    │ 填入 HTML 模板（含 SEO 标签）
    ▼
返回完整 HTML（title/meta/H1/正文/JSON-LD/canonical/内链）
```

要点：

- **canonical 与 URL 都落在 molio.cn 主域**，权重不分散。
- **落点决策（已定）**：SSR 路由加在 `apps/cloud`（即 auth.molio.cn 后端）。注意 auth.molio.cn 部署在阿里云函数计算 FC（serverless），不存在"同机/本机端口"形态——molio.cn 的 nginx 与它之间是**跨域 HTTPS 反向代理**（配置见 §六）。
- **现有页面全部不动**：首页、resources.html、博客、帮助页等仍由 nginx 直接吐静态文件。桌面客户端与购买流程走 auth.molio.cn 接口，与本改动零交集。
- **商品页同时是购买转化页**：SSR 输出的 HTML 自带完整内容（爬虫可读），同一份 HTML 里由官网静态脚本 `resource-hydrate.js` 渐进增强交互（登录门槛 / 微信支付 / 签名下载 / 灯箱）。SEO 流量进来即可购买，交互逻辑从旧 `resource.html` 迁移，行为对齐。

### 2.3 URL 策略

- 新商品页 URL 采用 **`/resource/{id}.html`**（id 为市场接口返回的稳定 ULID），语义清晰、零冲突、无需维护 slug 映射表；关键词由页面的 title/H1/正文承担。
- 旧地址 `resource.html?id={id}` 需 **301 永久跳转**到新地址，传递已积累的权重（哪怕暂时还没权重，也避免两套 URL 分裂）。

### 2.4 商品页 HTML 必须包含的要素

SSR 输出的每个商品页需包含（这是 SEO 效果的核心，缺一不可）：

1. `<title>`：商品名 + 品类词 + 品牌（如「XX图谱 — 知识图谱下载 | Molio」）。
2. `meta description`：商品摘要截断到约 150 字。
3. `<link rel="canonical">` 指向本页 molio.cn 地址。
4. Open Graph 标签（og:title / og:description / og:image / og:url / og:type=product）。
5. **Product 结构化数据（JSON-LD）**：name、description、image、sku=id、brand、offers（价格**由 priceCents 换算为元**、CNY、InStock）——价格可直接展示在搜索结果中。
6. 页面正文：H1=商品名、价格、作者/版本、summary 按行分段、标签；纯文本即可，无需执行 JS 即可读。
7. 内链：面包屑（首页 › 资源库 › 商品名，含 BreadcrumbList JSON-LD）+ 相关商品互链（从全量列表取若干非本品的商品）——形成商品之间的链接网络，帮助爬虫发现所有商品页。
8. 交互层（转化）：页面内嵌 `window.__LISTING__` 商品数据，加载官网 `auth.js` / `pay.js` / `resource-hydrate.js` 绑定购买/下载按钮——不执行 JS 不影响阅读，执行 JS 则购买流程完整可用。

### 2.5 配套：动态 sitemap

- SSR 服务提供 `/sitemap-products.xml` 路由：**实时**从 `/market/listings` 拉全量商品，生成包含所有 `/resource/{id}.html` 的 sitemap（lastmod 用商品 `publishedAt`）。
- 新商品自动出现在 sitemap 里，无需人工维护。
- molio.cn 现有的静态 `sitemap.xml` 改造为 sitemap index（或另行引用），把动态商品 sitemap 挂进去；nginx 需将 `/sitemap-products.xml` 也代理到 SSR 服务。

### 2.6 边界与容错

- 市场接口失败或商品不存在 → 返回 404（真实 404，不要返回软 200）。
- 市场接口超时要短（秒级），失败快速降级，不能拖垮响应。
- SSR 服务不可用时**只影响新商品页路径**，绝不能影响现有静态页面——nginx 层面天然隔离。
- 商品页允许适度缓存（如 1 小时），商品信息变化不频繁；**404 页不缓存**（`no-store`），避免新上架商品被早前的 404 缓存挡住。
- 商品名/摘要为社区用户提交内容，服务端拼 HTML 一律转义（XSS 防护）；内嵌 JSON 额外转 `<` 防 `</script>` 逃逸。
- 注意：市场列表接口上限 `LIST_LIMIT = 200`——商品数逼近时动态 sitemap 与相关商品会静默截断，届时需调大该常量。

## 三、技术栈与环境事实（开发前必读）

- molio.cn 静态站源码：`apps/landing-page/`（纯 HTML/CSS/JS，nginx 直接 serve）。
- 云端市场后端（auth.molio.cn）：`apps/cloud/`，技术栈为 **Hono + TypeScript + Node（ESM）**，数据在 PostgreSQL。
- monorepo：pnpm workspace，包名风格 `@molio/xxx`。
- 服务器 nginx 版本 1.21.5；molio.cn 当前仅有 HTTP/1.1（HTTP/2 优化另行处理，不属本任务范围，但 nginx 配置改动时可顺带评估）。
- **SSR 落点（已实现）**：`apps/cloud` 新增 `src/ssr/`（`render.ts` 纯函数模板 + `routes.ts` 路由），与 `/market` 同条件挂载（无 OSS 凭证 → 不挂载）。复用其 Hono 服务与部署管道，部署链路最短。molio.cn 的 nginx **跨域 HTTPS 反代**到 auth.molio.cn（FC serverless，非同机），需设置 `Host` 头与 SNI，见 §六。
- **官网侧配套（已实现）**：新增 `resource-hydrate.js`（交互层）；`resources.html` 与应用内「我的上架」链接改指新格式 `/resource/{id}.html`；`sitemap.xml` 改为 sitemap index（`sitemap-static.xml` + 动态 `sitemap-products.xml`）；旧 `resource.html` 已从源码退役（线上由 nginx 301 接管）。

## 四、任务拆解与验收标准

| # | 任务 | 验收标准 |
|---|---|---|
| 1 | SSR 商品页路由：`/resource/{id}.html` | `curl` 原始 HTML 可见商品名、价格、正文、canonical、Product JSON-LD；不执行任何 JS 也能读全文；**浏览器打开购买流程（登录门槛/微信支付/免费下载）完整可用** |
| 2 | 404 与容错 | 不存在的 id 返回 HTTP 404；市场接口超时不产生 5xx 长阻塞 |
| 3 | 动态 sitemap：`/sitemap-products.xml` | 返回合法 XML，包含全部在售商品 URL；新上架商品自动出现 |
| 4 | nginx：代理 `/resource/*.html` 与 `/sitemap-products.xml` 到 SSR；旧 `resource.html?id=xx` 301 到新地址 | 线上访问新 URL 返回完整页面；旧 URL 返回 301；其余路径行为与现在完全一致 |
| 5 | sitemap index 改造 | 主 sitemap 引用商品 sitemap，格式合法 |
| 6 | 上线后验证 | GSC/百度平台提交后，抽查商品页 1–2 周内被收录 |

## 五、明确不做的事（防止范围蔓延）

- 不改现有静态页面的任何内容与样式。
- 不动购买/支付/登录流程（auth.js、pay.js 不碰；`resource-hydrate.js` 只做既有交互逻辑的迁移）。
- 不做 URL 拼音 slug（id 已足够，避免引入 pinyin 依赖与映射维护）。
- 不做百度/Google 推送（另有 GitHub Action 方案负责）。
- 不做 HTTP/2、缓存策略、www 跳转等 nginx 其他优化（另有配置文档，可同批上线但不算本任务）。
- 不做 resources.html 列表页的服务端渲染（列表页目前仍是 CSR，爬虫顺面包屑进列表页看不到商品链接，商品发现靠 sitemap + 详情页互链兜底；如需强化入口页可另立任务）。

## 六、部署步骤（上线时执行）

### 6.1 云端（阿里云）

1. `apps/cloud` 代码合并后，按现有流程发布：`node apps/cloud/scripts/deploy-package.mjs` 产出部署包 → FC 控制台上传（环境变量无变化，**无需**改控制台配置）。
2. 验证：`curl -s https://auth.molio.cn/sitemap-products.xml` 返回合法 XML（在售商品数 = 市场在售数）。

### 6.2 molio.cn 的 nginx（静态站服务器）

在 molio.cn 的 server 块中加入以下配置（增量，不动既有规则）：

```nginx
# 旧商品详情地址 → 301 到新格式（$arg_id 缺失时落到下方静态/404 常规处理）
location = /resource.html {
    if ($arg_id) {
        return 301 /resource/$arg_id.html;
    }
    return 301 /resources.html;   # 无 id 的旧页已退役，导向资源库
}

# 商品详情页：跨域 HTTPS 反代到 auth.molio.cn（FC serverless，非本机端口）
location ~ ^/resource/[0-9A-Za-z]+\.html$ {
    proxy_pass https://auth.molio.cn;
    proxy_ssl_server_name on;              # SNI：FC 自定义域名必需
    proxy_set_header Host auth.molio.cn;   # 目标按 Host 路由，必须改写
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;                # 覆盖 FC 冷启动首请求
}

# 动态商品 sitemap：同样反代
location = /sitemap-products.xml {
    proxy_pass https://auth.molio.cn;
    proxy_ssl_server_name on;
    proxy_set_header Host auth.molio.cn;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
}
```

注意：

- `proxy_pass https://auth.molio.cn` 需 nginx 编译含 `http_ssl_module` 且支持上游 HTTPS（1.21.5 默认满足）；如上游证书链解析有问题可改用 `resolver` + 变量形式的 `proxy_pass`。
- SSR 服务自身带缓存头（页面 `public, max-age=3600`、sitemap 600s、404 `no-store`）；如需 nginx 侧再缓一层可另加 `proxy_cache`，首版不必。

### 6.3 静态站文件发布

把 `apps/landing-page/` 变更同步到 molio.cn 静态根目录：新增 `resource-hydrate.js`、`sitemap-static.xml`，更新 `sitemap.xml`（index）、`resources.html`，删除 `resource.html`。

### 6.4 上线验证清单

1. `curl` 新商品页原始 HTML：商品名/价格/正文/canonical/Product JSON-LD 齐全，无 JS 可读全文。
2. 浏览器打开新商品页：购买按钮可用（登录门槛、微信支付弹窗、免费下载链路）。
3. 旧地址 `resource.html?id=xx` 返回 301 → 新地址；无 id 的 `resource.html` 301 → `resources.html`。
4. `sitemap.xml`（index）与 `sitemap-products.xml` 均返回合法 XML；新上架商品自动出现。
5. 其余静态页面（首页/博客/帮助）行为与之前完全一致。
6. GSC/百度资源平台提交 `https://molio.cn/sitemap.xml`，1–2 周内抽查商品页收录。
