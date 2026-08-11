import { Hono, type Context } from 'hono';
import type { SendCodeRequest, VerifyRequest } from '@molio/contracts';
import { AuthClient, AuthCloudError } from '../core/auth/auth-client.js';

/**
 * daemon 本地镜像的云端认证端点（设计 §六「daemon 本地镜像」）。
 * Web UI 只跟这 4 个端点说话；daemon 是唯一 token 持有者与云端通信方。
 *
 * 错误映射：
 * - 云端 4xx → 原样透传（{error, ...extra}，如 rate_limited 带 resendAfterSec）
 * - 断网 → 502 cloud_unreachable
 * - MOLIO_AUTH_URL 未配置 → 503 auth_not_configured
 */
export function authRoutes(client: AuthClient): Hono {
  const app = new Hono();

  // 发送验证码。云端响应原样透传——daily/local 含 devCode（E2E 取码用），
  // prod 云端本就不返回 devCode，透传无泄漏面。
  app.post('/start', async (c) => {
    const body = (await c.req.json().catch(() => null)) as SendCodeRequest | null;
    if (!body || typeof body.email !== 'string' || body.email.trim() === '') {
      return c.json({ error: 'invalid_email' }, 400);
    }
    try {
      const res = await client.sendCode(body.email.trim());
      return c.json(res, 202);
    } catch (e) {
      return cloudError(c, e);
    }
  });

  // 验证码登录（注册=登录）；token 由 client 落盘，这里只回用户信息。
  app.post('/verify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as VerifyRequest | null;
    if (
      !body ||
      typeof body.email !== 'string' ||
      typeof body.code !== 'string' ||
      body.email.trim() === '' ||
      body.code.trim() === ''
    ) {
      return c.json({ error: 'invalid_code' }, 400);
    }
    try {
      const res = await client.verify(body.email.trim(), body.code.trim());
      return c.json({ user: res.user, loggedIn: true });
    } catch (e) {
      return cloudError(c, e);
    }
  });

  // 登录态快照（不发网络请求；离线时 stale=true，数据来自本地缓存）。
  app.get('/status', async (c) => c.json(await client.getStatus()));

  // 登出：云端吊销尽力而为，本地必清（local-first 红线）。
  app.post('/logout', async (c) => {
    await client.logout();
    return c.json({ ok: true });
  });

  // 注销账号（设计 §7.4 个保法硬要求）：云端软删除 + 吊销全部 session。
  // 与 logout 不同：云端不可达时抛错不清本地（账号还在，保留 token 供重试）。
  app.delete('/account', async (c) => {
    try {
      await client.deleteAccount();
      return c.json({ ok: true });
    } catch (e) {
      return cloudError(c, e);
    }
  });

  return app;
}

type ErrorStatus = 400 | 401 | 404 | 429 | 502 | 503;

function cloudError(c: Context, e: unknown): Response {
  if (e instanceof AuthCloudError) {
    if (e.status === 0 && e.code === 'no_session') {
      return c.json({ error: 'no_session' }, 401);
    }
    if (e.status === 0) {
      return c.json({ error: 'cloud_unreachable' }, 502);
    }
    const status: ErrorStatus =
      e.status >= 400 && e.status < 500 ? (e.status as ErrorStatus) : e.status === 503 ? 503 : 502;
    return c.json({ error: e.code, ...e.extra }, status);
  }
  throw e;
}
