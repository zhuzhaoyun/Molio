// apps/cloud/src/ssr/routes.ts
// 官网商品页 SSR 路由（设计：docs/2026-09-01-ssr-product-pages-design.md）。
// molio.cn 的 nginx 把 /resource/*.html 与 /sitemap-products.xml 反代到本服务；
// 页面在请求时实时读市场数据渲染 —— 新商品上架即可收录，零构建步骤。
//
// 容错原则（设计 §2.6）：市场数据取不到时返回真实 404 / 空 sitemap，
// 绝不 5xx 长阻塞拖垮爬虫与代理链路。
import { Hono, type Context } from 'hono';
import { MarketServiceError, type MarketService } from '../market/service.js';
import { renderListingPage, renderLlmsTxt, renderNotFoundPage, renderProductPage, renderProductsSitemap } from './render.js';

export interface SsrRoutesDeps { service: MarketService; }

/** 商品页缓存 1 小时：商品信息变化不频繁，缓存显著降低 FC 冷启动暴露面 */
const PAGE_CACHE = 'public, max-age=3600';
const SITEMAP_CACHE = 'public, max-age=600';
/** 404 不缓存：新商品上架后不能因为早前的一次 404 被挡在缓存里 */
const MISS_CACHE = 'no-store';

// ULID 是 26 位 Crockford base32；放宽到字母数字 1-64，其余交给 service 判 404
const ID_RE = /^[0-9A-Za-z]{1,64}\.html$/;

export function ssrRoutes(deps: SsrRoutesDeps): Hono {
  const app = new Hono();

  app.get('/resource/:id', async (c) => {
    const raw = c.req.param('id');
    if (!ID_RE.test(raw)) return notFound(c);
    const id = raw.slice(0, -'.html'.length);
    try {
      const listing = await deps.service.get(id);
      // 相关商品：全量列表排除自身取前 6；取失败不影响主内容（空即可）
      const related = await deps.service.list()
        .then((all) => all.filter((l) => l.id !== id).slice(0, 6))
        .catch(() => []);
      c.header('Cache-Control', PAGE_CACHE);
      return c.html(renderProductPage(listing, related));
    } catch (e) {
      if (!(e instanceof MarketServiceError && e.status === 404)) {
        // 非预期错误（DB 故障等）：记日志，但对爬虫仍按 404 降级（设计约定，不产生 5xx）
        console.error('[cloud] ssr render error:', e);
      }
      return notFound(c);
    }
  });

  app.get('/resources.html', async (c) => {
    let listings: Awaited<ReturnType<MarketService['list']>> = [];
    try {
      listings = await deps.service.list();
    } catch (e) {
      // 市场数据取不到 → 渲染空态列表页（骨架/导航仍在），绝不 5xx 拖垮爬虫
      console.error('[cloud] ssr listing error:', e);
    }
    c.header('Cache-Control', PAGE_CACHE);
    return c.html(renderListingPage(listings));
  });

  app.get('/sitemap-products.xml', async (c) => {
    let listings: Awaited<ReturnType<MarketService['list']>> = [];
    try {
      listings = await deps.service.list();
    } catch (e) {
      // 接口故障 → 输出合法空 sitemap，好过 5xx（爬虫会重试，空集不伤收录存量）
      console.error('[cloud] ssr sitemap error:', e);
    }
    c.header('Content-Type', 'application/xml; charset=utf-8');
    c.header('Cache-Control', SITEMAP_CACHE);
    return c.body(renderProductsSitemap(listings));
  });

  app.get('/llms.txt', async (c) => {
    let listings: Awaited<ReturnType<MarketService['list']>> = [];
    try {
      listings = await deps.service.list();
    } catch (e) {
      // 接口故障 → 返回合法但商品为空的 llms.txt（骨架仍在），好过 5xx 拖垮 AI 爬虫
      console.error('[cloud] ssr llms.txt error:', e);
    }
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Cache-Control', SITEMAP_CACHE);
    return c.body(renderLlmsTxt(listings));
  });

  return app;
}

function notFound(c: Context): Response {
  c.header('Cache-Control', MISS_CACHE);
  return c.html(renderNotFoundPage(), 404);
}
