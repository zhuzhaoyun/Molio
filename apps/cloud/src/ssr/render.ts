// apps/cloud/src/ssr/render.ts
// 商品详情页 / 动态 sitemap 的服务端渲染（设计：docs/2026-09-01-ssr-product-pages-design.md）。
// 纯函数模块：只吃 MarketListing 吐字符串，不发请求、不碰时钟 → 可单测。
//
// 两条消费方：
//   1. 搜索引擎 / AI 爬虫 —— 不执行 JS，HTML 必须自带完整内容与结构化数据；
//   2. 真实用户 —— 同一份 HTML 是购买转化页：按钮/登录/支付交互由
//      /resource-hydrate.js（官网静态文件）读内嵌 __LISTING__ 激活（渐进增强）。
//
// 安全：商品 name/summary/tags 等是用户提交内容，拼 HTML 一律过 escapeHtml；
// 内嵌 JSON 额外把 '<' 转成 < 防 </script> 逃逸。

import type { MarketListing } from '@molio/contracts';

export const SITE_BASE = 'https://molio.cn';
// 与官网 resources-data.js 的 MOLIO_PAY_BASE 保持一致（支付后端正式域名）
export const PAY_BASE = 'https://pay.molio.cn';

/** 商品页规范地址（canonical / sitemap / og:url 共用） */
export function productUrl(id: string): string {
  return `${SITE_BASE}/resource/${id}.html`;
}

/** HTML 转义：与官网 resource.html 的 esc() 同一张表 */
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

/** 内嵌 <script> 的 JSON：转掉 '<' 防用户内容里的 </script> 截断脚本块 */
export function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

/** meta description：摘要折叠换行后按码点截断（中文 1 字符 = 1 码点） */
export function metaDescription(summary: string, max = 150): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  return cps.length > max ? cps.slice(0, max).join('') + '…' : flat;
}

function formatPriceYuan(cents: number): string {
  return String(cents / 100);
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  return `${d.getFullYear()}-${mm < 10 ? '0' + mm : mm}-${dd < 10 ? '0' + dd : dd}`;
}

// ── 结构化数据 ──

function productJsonLd(m: MarketListing): string {
  const image = m.previews.length > 0 ? m.previews : [`${SITE_BASE}/images/brand.webp`];
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: m.name,
    description: metaDescription(m.summary, 500),
    image,
    sku: m.id,
    brand: { '@type': 'Brand', name: 'Molio 墨流' },
    offers: {
      '@type': 'Offer',
      url: productUrl(m.id),
      priceCurrency: 'CNY',
      price: (m.priceCents / 100).toFixed(2),
      availability: 'https://schema.org/InStock',
    },
  };
  return `<script type="application/ld+json">${safeJson(ld)}</script>`;
}

function breadcrumbJsonLd(m: MarketListing): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: `${SITE_BASE}/` },
      { '@type': 'ListItem', position: 2, name: '资源库', item: `${SITE_BASE}/resources.html` },
      { '@type': 'ListItem', position: 3, name: m.name, item: productUrl(m.id) },
    ],
  };
  return `<script type="application/ld+json">${safeJson(ld)}</script>`;
}

// ── 页面骨架（与官网静态页同款 nav/footer；资源引用一律根相对路径，页面在 /resource/ 目录下）──

const NAV = `
<nav class="top-nav" aria-label="主导航">
  <div class="nav-inner">
    <a href="/index.html" class="nav-logo"><img class="logo-icon-sm" src="/images/new/black.png" alt="Molio" /> Molio</a>
    <div class="nav-links">
      <a href="/index.html" class="nav-link">首页</a>
      <a href="/resources.html" class="nav-link active">资源</a>
      <a href="/help.html" class="nav-link">使用指南</a>
      <a href="/blog/index.html" class="nav-link">博客</a>
      <a href="/enterprise.html" class="nav-link">定制服务</a>
      <a href="https://github.com/zhuzhaoyun/Molio" target="_blank" rel="noopener noreferrer" class="nav-gh" aria-label="GitHub 仓库"><svg viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.102 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg></a>
    </div>
  </div>
</nav>`;

const FOOTER = `
<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <a href="/index.html" class="footer-logo"><img class="logo-icon-sm" src="/images/new/black.png" alt="Molio" /> Molio</a>
      <p>兼容 Obsidian 的本地 AI 知识库。内置 Claude Code 图形界面、微信 AI 助手和 Chrome Web Clipper，数据全在你自己电脑上。</p>
    </div>
    <div class="footer-links">
      <h4>产品</h4>
      <a href="/index.html">首页</a>
      <a href="/resources.html">资源</a>
      <a href="/help.html">使用指南</a>
      <a href="/enterprise.html">定制服务</a>
      <a href="https://github.com/zhuzhaoyun/Molio" target="_blank" rel="noopener noreferrer">GitHub 开源</a>
    </div>
    <div class="footer-links">
      <h4>资源</h4>
      <a href="/help.html">快速入门</a>
      <a href="/help.html#step-3">排版发布</a>
      <a href="/help.html#connect">连接微信</a>
      <a href="https://github.com/zhuzhaoyun/Molio/issues" target="_blank" rel="noopener noreferrer">问题反馈</a>
    </div>
    <div class="footer-links">
      <h4>关于</h4>
      <a href="/blog/index.html">博客</a>
      <a href="/privacy.html">隐私政策</a>
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">粤ICP备2023134483号</a>
    </div>
  </div>
  <div class="footer-bottom">
    <span>© 2026 Molio 墨流. 基于 MIT 协议开源.</span>
    <span>Molio 墨流 — 兼容 Obsidian 的本地知识库 + Claude Code GUI + 微信 AI 助手，数据全在你自己电脑上</span>
  </div>
</footer>`;

// GA4 + 百度统计：与官网静态页同款（行为分析不因换页断档）
const ANALYTICS = `
<script async src="https://www.googletagmanager.com/gtag/js?id=G-X6LMX9VR0Y"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-X6LMX9VR0Y');
</script>
<script>
var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?887d065c4dc67dfb05913b2e131a44a3";
  var s = document.getElementsByTagName("script")[0];
  s.parentNode.insertBefore(hm, s);
})();
</script>`;

// ── 商品页 ──

/** 购买/下载 CTA：按付费形态三选一（与旧 resource.html renderMarketDetail 同逻辑） */
function renderCta(m: MarketListing): { cta: string; note: string } {
  const price = formatPriceYuan(m.priceCents);
  if (m.priceCents > 0 && m.payUrl) {
    return {
      cta: `<button type="button" class="btn btn-primary" id="payurl-btn" data-url="${escapeHtml(m.payUrl)}" data-auth-gate="购买 ¥${escapeHtml(price)}">购买 ¥${escapeHtml(price)}</button>`,
      note: '点击后在支付页完成付款，自动发货下载链接。',
    };
  }
  if (m.priceCents > 0) {
    return {
      cta: `<button type="button" class="btn btn-primary" id="pay-btn" data-auth-gate="微信支付 ¥${escapeHtml(price)}">微信支付 ¥${escapeHtml(price)}</button>`,
      note: '扫码支付成功后自动解锁下载，下载链接 1 小时内有效。',
    };
  }
  return {
    cta: '<button type="button" class="btn btn-primary" id="market-dl-btn" data-auth-gate="下载 .zip">下载 .zip</button>',
    note: '下载解压后，用 Molio“打开本地仓库”加载即可开始阅读与写作。',
  };
}

function renderRelated(related: MarketListing[]): string {
  if (related.length === 0) return '';
  const cards = related.map((r) => {
    const paid = r.priceCents > 0;
    return `<article class="rl-card">
      <div class="rl-top">
        <div class="rl-icon" style="background:${escapeHtml(r.tint)}">${escapeHtml(r.icon)}</div>
        <div class="rl-titles"><h3 class="rl-name">${escapeHtml(r.name)}</h3></div>
        <span class="rl-price ${paid ? 'paid' : 'free'}">${paid ? '¥' + escapeHtml(formatPriceYuan(r.priceCents)) : '免费'}</span>
      </div>
      <p class="rl-desc">${escapeHtml(metaDescription(r.summary, 80))}</p>
      <div class="rl-actions"><a class="rl-detail" href="/resource/${encodeURIComponent(r.id)}.html">查看详情 →</a></div>
    </article>`;
  }).join('\n');
  return `
<section class="res-section">
  <h2 class="res-section-title">相关资源</h2>
  <div class="res-grid">${cards}</div>
</section>`;
}

/**
 * 渲染完整商品详情页。
 * 注意：正文内容全部服务端产出（爬虫零 JS 可读）；交互（登录门槛/支付/下载/灯箱）
 * 由 resource-hydrate.js 读 __LISTING__ 渐进增强，脚本加载前页面已完整可读。
 */
export function renderProductPage(m: MarketListing, related: MarketListing[]): string {
  const url = productUrl(m.id);
  const title = `${m.name} — 知识图谱下载 | Molio`;
  const desc = metaDescription(m.summary);
  const ogImage = m.previews.length > 0 ? m.previews[0]! : `${SITE_BASE}/images/brand.webp`;
  const paid = m.priceCents > 0;
  const price = formatPriceYuan(m.priceCents);
  const { cta, note } = renderCta(m);

  // 正文：摘要按空行分段 + 详情段落 + 亮点（与旧详情页 renderMarketDetail 一致）
  const summaryParas = m.summary.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const overviewParas = m.overview.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const highlights = m.highlights.length > 0
    ? '<ul>' + m.highlights.map((h) => `<li><strong>${escapeHtml(h)}</strong></li>`).join('') + '</ul>'
    : '';
  const tags = m.tags.length > 0
    ? `<div class="res-tags">${m.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  const previews = m.previews.map((p) => `<figure><a href="${escapeHtml(p)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(p)}" alt="${escapeHtml(m.name)} 效果预览" loading="lazy"></a></figure>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#1A1714">

<!-- SEO：每个商品独立 title/description/canonical（CSR 时代全站共用一份，是收录失败的根因之一） -->
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${url}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="icon" type="image/png" href="/images/favicon-32.png">
<link rel="apple-touch-icon" href="/images/favicon-180.png">
<link rel="stylesheet" href="/styles.css?v=20260828a">

<!-- Open Graph -->
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:type" content="product">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:site_name" content="Molio 墨流">
<meta property="og:locale" content="zh_CN">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">

${productJsonLd(m)}
${breadcrumbJsonLd(m)}
</head>
<body>
${NAV}

<main class="page-content page-wide">
  <div id="res-detail">
    <div class="breadcrumb"><a href="/index.html">首页</a><span class="sep">/</span><a href="/resources.html">资源</a><span class="sep">/</span> ${escapeHtml(m.name)}</div>
    <div class="res-detail-head reveal">
      <div class="res-icon" style="background:${escapeHtml(m.tint)}">${escapeHtml(m.icon)}</div>
      <div>
        <div class="res-detail-title"><h1>${escapeHtml(m.name)}</h1>
        <span class="res-price ${paid ? 'paid' : 'free'}">${paid ? '¥' + escapeHtml(price) : '免费'}</span></div>
        <div class="res-meta-line">Markdown 格式 · 兼容 Obsidian · 用 Molio“打开本地仓库”加载</div>
        ${tags}
      </div>
    </div>
    <div class="res-detail-grid">
      <div class="res-main">
        <h2 class="res-section-title">概述</h2>
        <div class="article-body">${summaryParas}${overviewParas}${highlights}</div>
        ${previews ? `<h2 class="res-section-title">效果预览</h2>
        <div class="res-preview-grid">${previews}</div>` : ''}
        <h2 class="res-section-title">资源包导入说明</h2>
        <div class="step-card"><ol>
          <li>下载资源包 <code>.zip</code> 并解压到本地任意目录</li>
          <li>打开 Molio，在知识库管理界面选择“打开本地仓库”</li>
          <li>选择（或输入）解压后的文件夹路径，资源包立即加载</li>
        </ol></div>
      </div>
      <aside class="res-side">
        <div class="res-side-card reveal">${cta}<p class="res-side-note">${escapeHtml(note)}</p></div>
        <div class="res-side-card reveal">
          <div class="res-info-row"><span class="k">作者</span><span class="v">${escapeHtml(m.author)}</span></div>
          <div class="res-info-row"><span class="k">版本</span><span class="v">${escapeHtml(m.version)}</span></div>
          <div class="res-info-row"><span class="k">大小</span><span class="v">${formatSize(m.fileSize)}</span></div>
          <div class="res-info-row"><span class="k">发布时间</span><span class="v">${formatDate(m.publishedAt)}</span></div>
          <div class="res-info-row"><span class="k">格式</span><span class="v">Markdown（.zip）</span></div>
          <div class="res-info-row"><span class="k">兼容</span><span class="v">Molio / Obsidian</span></div>
          <div class="res-info-row"><span class="k">价格</span><span class="v">${paid ? '¥' + escapeHtml(price) : '免费'}</span></div>
        </div>
      </aside>
    </div>
    ${renderRelated(related)}
  </div>
</main>

<!-- 灯箱：预览图点击放大（交互由 resource-hydrate.js 绑定） -->
<div class="res-lightbox" id="res-lightbox" hidden role="dialog" aria-modal="true" aria-label="效果预览大图">
  <button type="button" class="res-lightbox-close" aria-label="关闭">×</button>
  <img src="" alt="效果预览大图">
</div>

${FOOTER}

<!-- 交互层：登录门槛 / 微信支付 / 签名下载 / 灯箱。内嵌 __LISTING__ 避免二次请求 -->
<script>window.MOLIO_PAY_BASE = '${PAY_BASE}';window.__LISTING__ = ${safeJson(m)};</script>
<script src="/vendor/qrcode.min.js"></script>
<script src="/auth.js?v=20260824a"></script>
<script src="/pay.js?v=20260823a"></script>
<script src="/resource-hydrate.js?v=20260901a"></script>
<script src="/shared.js?v=20260813a"></script>
${ANALYTICS}
</body>
</html>`;
}

/** 商品不存在（真 404，非软 200）：保留导航与出口链接，降低用户流失 */
export function renderNotFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>资源不存在 — Molio 资源</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="/images/favicon-32.png">
<link rel="stylesheet" href="/styles.css?v=20260828a">
</head>
<body>
${NAV}
<main class="page-content page-wide">
  <div class="breadcrumb"><a href="/index.html">首页</a><span class="sep">/</span><a href="/resources.html">资源</a></div>
  <h1 class="page-title">资源不存在</h1>
  <div class="tip-box">你访问的资源不存在或已下架。<a href="/resources.html">返回资源库 →</a></div>
</main>
${FOOTER}
</body>
</html>`;
}

// ── 动态 sitemap ──

/** 商品 sitemap：实时全量在售商品；lastmod 取 publishedAt（上架日） */
export function renderProductsSitemap(listings: MarketListing[]): string {
  const urls = listings.map((m) => `  <url>
    <loc>${productUrl(m.id)}</loc>
    ${m.publishedAt ? `<lastmod>${formatDate(m.publishedAt)}</lastmod>` : ''}
    <changefreq>weekly</changefreq>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

// ── llms.txt ──

/**
 * llms.txt：给 AI 爬虫 / 大模型读的站点说明书（设计：docs/2026-09-01-llms-txt-dynamic-design.md）。
 * 与 /sitemap-products.xml 对称 —— 运行时实时拼出全部在售商品，新上架自动出现，零手工维护。
 * 定位「资源重心」：知识图谱商品是营收主角，Molio 软件降级为免费载体。
 * 纯文本 Markdown（text/plain），不产出 HTML；name/summary 是用户提交内容，过 escapeHtml 防注入。
 */
export function renderLlmsTxt(listings: MarketListing[]): string {
  const sorted = [...listings].sort((a, b) => a.priceCents - b.priceCents);
  const free = sorted.filter((m) => m.priceCents === 0);
  const paid = sorted.filter((m) => m.priceCents > 0);
  // name 会进 Markdown 链接文本，折叠换行防注入伪造结构
  const safeName = (m: MarketListing) => escapeHtml(m.name).replace(/[\r\n]+/g, ' ').trim();

  const out: string[] = [
    '# Molio 墨流 · 知识图谱资源库',
    '',
    '> 本站是「结构化知识图谱 / 知识体系」资源库。提供《红楼梦》人物关系图谱、《资治通鉴》知识体系、妇产超声知识图谱、知识工程全景图谱等，Markdown 格式，购买后可一键导入 Molio 或 Obsidian 等本地 AI 知识库。',
    '',
    '## 本站卖什么',
    '',
    '- **知识图谱资源（核心，付费）**：把经典著作 / 专业领域整理成结构化、可关联、可被 AI 问答引用的知识图谱，不是散乱资料堆。',
    '- **Molio 软件（免费开源）**：本地优先的 AI 知识库 + 知识图谱桌面应用，是上述资源的阅读器与载体，永久免费。',
    '',
    '## 与免费开源资源的区别',
    '',
    '免费开源图谱（如 OpenKG、HonglouData）是「原始数据集」，需自行清洗、建关系、写导读；本站资源是「成品」——已结构化、带导读、可直接导入 AI 知识库做问答与联想。',
    '',
    '## 资源品类',
    '',
    '- **文学国学**：经典著作的结构化知识图谱，涵盖人物关系、历史脉络、意象解读。',
    '- **哲学**：中西哲学思想体系，概念关联与流派演变。',
    '- **医学中医**：临床知识与传统医学理论的图谱化整理。',
    '- **技术工程**：知识工程全景图谱，涵盖本体论、知识表示、语义网、RAG/GraphRAG、AI Agent 工程等关键概念。',
    '',
    '## 在售资源',
    '',
  ];

  if (free.length > 0) {
    out.push('### 免费资源');
    for (const m of free) {
      out.push(`- [${safeName(m)}](${productUrl(m.id)})：${escapeHtml(metaDescription(m.summary, 60))}`);
    }
    out.push('');
  }
  if (paid.length > 0) {
    out.push('### 付费资源');
    for (const m of paid) {
      out.push(`- [${safeName(m)}](${productUrl(m.id)})：¥${formatPriceYuan(m.priceCents)} — ${escapeHtml(metaDescription(m.summary, 60))}`);
    }
    out.push('');
  }

  out.push(
    '## 软件（免费）',
    '',
    '- Molio 桌面端：本地 AI 知识库，免费开源（MIT），GitHub：https://github.com/zhuzhaoyun/Molio',
    '',
    '## 核心页面',
    '',
    '- [首页](https://molio.cn/)：产品介绍、下载入口。',
    '- [资源市场](https://molio.cn/resources.html)：全部在售知识图谱资源。',
    '- [使用指南](https://molio.cn/help.html)',
    '- [博客](https://molio.cn/blog/index.html)',
    '',
    '## 博客文章',
    '',
    '- [Obsidian 替代方案](https://molio.cn/blog/obsidian-alternative.html)',
    '- [Molio vs Obsidian 对比](https://molio.cn/blog/molio-vs-obsidian.html)',
    '- [Claude Code 图形界面指南](https://molio.cn/blog/claude-code-gui-guide.html)',
    '- [本地知识库搭建](https://molio.cn/blog/local-knowledge-base.html)',
    '',
    '## 关键信息',
    '',
    '- 品牌：Molio（墨流）；域名：molio.cn；源码：github.com/zhuzhaoyun/Molio。',
    '- 商品格式：Markdown（.zip）；兼容：Molio / Obsidian。',
    '- 购买：付费资源扫码支付后自动发货，下载链接 1 小时内有效；免费资源直接下载。',
    '',
  );

  return out.join('\n');
}
