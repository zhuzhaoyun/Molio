import { Hono, type Context } from 'hono';
import type { RefreshRequest, SendCodeRequest, VerifyRequest } from '@molio/contracts';
import type { CloudConfig } from './config.js';
import { verifyAccessToken, type AccessPayload } from './jwt.js';
import { AuthService, ServiceError } from './service.js';

export interface AppDeps {
  service: AuthService;
  config: CloudConfig;
  storeKind: 'memory' | 'pg';
  /** 可注入时钟（与 service 同一时钟），测试用 */
  now: () => number;
}

function clientIp(c: Context): string | null {
  // FC/网关经 X-Forwarded-For 传真实 IP；本地直连为 null（本机调试不做 IP 限频）
  const xff = c.req.header('x-forwarded-for');
  if (!xff) return null;
  const first = xff.split(',')[0]?.trim();
  return first || null;
}

function handleError(c: Context, e: unknown): Response {
  if (e instanceof ServiceError) {
    return c.json({ error: e.code, ...e.extra }, e.status as 400 | 401 | 404 | 429);
  }
  throw e;
}

function bearer(c: Context, config: CloudConfig, now: () => number): AccessPayload | null {
  const header = c.req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  return verifyAccessToken(header.slice('Bearer '.length), config.jwtSecret, Math.floor(now() / 1000));
}

/**
 * 云端认证服务（第一期 6 端点，§六）。
 * 不配 CORS：第一期 Web UI 一律经 daemon，无浏览器直连（§八）。
 */
export function createApp(deps: AppDeps): Hono {
  const { service, config } = deps;
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, env: config.env, store: deps.storeKind }));

  app.post('/auth/send-code', async (c) => {
    const body = (await c.req.json().catch(() => null)) as SendCodeRequest | null;
    if (!body || typeof body.email !== 'string') {
      return c.json({ error: 'invalid_email' }, 400);
    }
    try {
      const res = await service.sendCode(body.email, clientIp(c));
      return c.json(res, 202);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post('/auth/verify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as VerifyRequest | null;
    if (!body || typeof body.email !== 'string' || typeof body.code !== 'string') {
      return c.json({ error: 'invalid_code' }, 401);
    }
    try {
      const res = await service.verify(body.email, body.code, body.deviceHint);
      return c.json(res, 200);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post('/auth/refresh', async (c) => {
    const body = (await c.req.json().catch(() => null)) as RefreshRequest | null;
    if (!body || typeof body.refreshToken !== 'string') {
      return c.json({ error: 'invalid_token' }, 401);
    }
    try {
      const res = await service.refresh(body.refreshToken);
      return c.json(res, 200);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/auth/me', async (c) => {
    const payload = bearer(c, config, deps.now);
    if (!payload) return c.json({ error: 'invalid_token' }, 401);
    try {
      return c.json(await service.me(payload.sub), 200);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete('/auth/session', async (c) => {
    const payload = bearer(c, config, deps.now);
    if (!payload) return c.json({ error: 'invalid_token' }, 401);
    const body = (await c.req.json().catch(() => null)) as { refreshToken?: string } | null;
    if (!body || typeof body.refreshToken !== 'string') {
      return c.json({ error: 'invalid_token' }, 401);
    }
    try {
      return c.json(await service.logout(body.refreshToken), 200);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete('/auth/account', async (c) => {
    const payload = bearer(c, config, deps.now);
    if (!payload) return c.json({ error: 'invalid_token' }, 401);
    try {
      return c.json(await service.deleteAccount(payload.sub), 200);
    } catch (e) {
      return handleError(c, e);
    }
  });

  return app;
}
