// apps/cloud/src/market/routes.ts
// /market/* 路由（设计 §六）。错误归一：MarketServiceError → {error,...extra}；
// 其余兜底 internal/500（绝不让裸文本漏给客户端）。
import { Hono, type Context } from 'hono';
import type { CloudConfig } from '../config.js';
import { verifyAccessToken, type AccessPayload } from '../jwt.js';
import type { MarketService, MarketServiceError } from './service.js';

export interface MarketRoutesDeps { service: MarketService; }

const MAX_JSON_BODY = 64 * 1024;

export function marketRoutes(deps: MarketRoutesDeps, config: CloudConfig, now: () => number): Hono {
  const app = new Hono();
  const { service } = deps;

  const bearer = (c: Context): AccessPayload | null => {
    const h = c.req.header('authorization');
    if (!h || h.slice(0, 7).toLowerCase() !== 'bearer ') return null;
    return verifyAccessToken(h.slice(7), config.jwtSecret, Math.floor(now() / 1000));
  };
  const handle = (c: Context, e: unknown): Response => {
    const err = e as Partial<MarketServiceError>;
    if (err && typeof err.code === 'string' && typeof err.status === 'number') {
      return c.json({ error: err.code, ...(err.extra ?? {}) }, err.status as 400);
    }
    console.error('[cloud] market unhandled error:', e);
    return c.json({ error: 'internal' }, 500);
  };
  const guardBody = (c: Context): Response | null => {
    const len = Number(c.req.header('content-length') ?? '0');
    if (!Number.isFinite(len) || len > MAX_JSON_BODY) return c.json({ error: 'payload_too_large' }, 413);
    return null;
  };

  app.get('/listings', async (c) => {
    c.header('Cache-Control', 'no-store');
    try { return c.json({ listings: await service.list() }, 200); } catch (e) { return handle(c, e); }
  });

  // §九：定价端点，公开给 wxpay-fc（价格是公开信息；file 为 zip 全量 key，桶私有无下载能力）
  app.get('/pricing/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    try { return c.json(await service.pricing(c.req.param('id')), 200); } catch (e) { return handle(c, e); }
  });

  // 注意顺序：/listings/:id/download 必须先于 /listings/:id 注册（否则 download 被当作 id）
  app.get('/listings/:id/download', async (c) => {
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    try { return c.json(await service.download(p.sub, c.req.param('id')), 200); } catch (e) { return handle(c, e); }
  });

  app.get('/listings/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    try { return c.json(await service.get(c.req.param('id')), 200); } catch (e) { return handle(c, e); }
  });

  app.post('/listings', async (c) => {
    const denied = guardBody(c); if (denied) return denied;
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_metadata' }, 400);
    try { return c.json(await service.create(p.sub, body as never), 201); } catch (e) { return handle(c, e); }
  });

  app.post('/listings/:id/confirm', async (c) => {
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    try { return c.json(await service.confirm(p.sub, c.req.param('id')), 200); } catch (e) { return handle(c, e); }
  });

  app.post('/listings/:id/update', async (c) => {
    const denied = guardBody(c); if (denied) return denied;
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    const body = await c.req.json().catch(() => null) as { previews?: { ext: string; size: number }[]; priceCents?: number } | null;
    try { return c.json(await service.update(p.sub, c.req.param('id'), body ?? {}), 200); } catch (e) { return handle(c, e); }
  });

  app.delete('/listings/:id', async (c) => {
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    try { return c.json(await service.remove(p.sub, c.req.param('id')), 200); } catch (e) { return handle(c, e); }
  });

  app.get('/my', async (c) => {
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    try { return c.json(await service.my(p.sub, p.email), 200); } catch (e) { return handle(c, e); }
  });

  app.get('/admin/listings', async (c) => {
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    try { return c.json({ listings: await service.adminList(p.email) }, 200); } catch (e) { return handle(c, e); }
  });

  app.post('/admin/listings/:id/remove', async (c) => {
    const denied = guardBody(c); if (denied) return denied;
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    const body = await c.req.json().catch(() => null) as { reason?: string } | null;
    try { return c.json(await service.adminRemove(p.email, c.req.param('id'), body?.reason), 200); } catch (e) { return handle(c, e); }
  });

  app.post('/admin/listings/:id/restore', async (c) => {
    const p = bearer(c);
    if (!p) return c.json({ error: 'invalid_token' }, 401);
    try { return c.json(await service.restore(p.email, c.req.param('id')), 200); } catch (e) { return handle(c, e); }
  });

  return app;
}
