import { Hono, type Context } from 'hono';
import type { SendCodeRequest, VerifyRequest } from '@molio/contracts';
import { AuthClient, AuthCloudError } from '../core/auth/auth-client.js';

/**
 * daemon 本地镜像的云端认证端点（设计 §六「daemon 本地镜像」）。
 * Web UI 只跟这 4 个端点说话；daemon 是唯一 token 持有者与云端通信方。
 *
 * 错误映射：
 * - 云端 4xx → 原样透传（{error, ...extra}，如 rate_limited 带 resendAfterSec、
 *   mail_failed=发信通道失败）
 * - 断网 → 502 cloud_unreachable
 * - MOLIO_AUTH_URL 未配置 → 503 auth_not_configured
 *
 * 本机攻击面说明：daemon 无鉴权且 CORS 放行任意 localhost origin（见 server.ts，
 * dev 拓扑 web:5173 → daemon:3100 必须放行）。因此写端点加 Origin 白名单
 * （localhost/127.0.0.1 或与 Host 同源）挡掉**远程**页面驱动的 CSRF（如恶意网页
 * 诱导浏览器 POST /logout 清登录态）；本机进程的请求不带 Origin，不受影响。
 * 本机恶意进程本就能直连 daemon，不在该检查的防御范围内。
 */
export function authRoutes(client: AuthClient): Hono {
  const app = new Hono();

  // 发送验证码。云端响应原样透传——daily/local 含 devCode（E2E 取码用），
  // prod 云端本就不返回 devCode，透传无泄漏面。
  app.post('/start', async (c) => {
    const denied = denyCrossOrigin(c) ?? denyOversizedBody(c);
    if (denied) return denied;
    const body = (await readJsonBody(c)) as SendCodeRequest | null;
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
    const denied = denyCrossOrigin(c) ?? denyOversizedBody(c);
    if (denied) return denied;
    const body = (await readJsonBody(c)) as VerifyRequest | null;
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
  app.get('/status', async (c) => {
    try {
      return c.json(await client.getStatus());
    } catch {
      // getStatus 全链路防御性解析，理论不抛；兜底防磁盘/解密异常打穿成 500 裸栈
      return c.json({ error: 'internal' }, 500);
    }
  });

  // 登出：云端吊销尽力而为，本地必清（local-first 红线）。
  app.post('/logout', async (c) => {
    const denied = denyCrossOrigin(c);
    if (denied) return denied;
    await client.logout();
    return c.json({ ok: true });
  });

  // 注销账号（设计 §7.4 个保法硬要求）：云端软删除 + 吊销全部 session。
  // 与 logout 不同：云端不可达时抛错不清本地（账号还在，保留 token 供重试）。
  app.delete('/account', async (c) => {
    const denied = denyCrossOrigin(c);
    if (denied) return denied;
    try {
      await client.deleteAccount();
      return c.json({ ok: true });
    } catch (e) {
      return cloudError(c, e);
    }
  });

  return app;
}

type ErrorStatus = 400 | 401 | 404 | 409 | 422 | 429 | 502 | 503;

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

/**
 * Origin 白名单（仅写端点）。策略与 server.ts 的 CORS 一致：
 * - 无 Origin（curl / E2E / daemon 互调等非浏览器客户端）→ 放行
 * - Origin host 与 Host 头完全一致（NAS/生产：web 由 daemon 自身伺服）→ 放行
 * - localhost / 127.0.0.1 任意端口（dev 拓扑：vite:5173 → daemon:3100，
 *   Vite proxy 原样转发 Origin）→ 放行
 * - 其余（远程页面、伪造 Origin）→ 403
 */
function denyCrossOrigin(c: Context): Response | null {
  const origin = c.req.header('origin');
  if (!origin) return null;
  let allowed = false;
  try {
    const url = new URL(origin);
    const host = c.req.header('host');
    const isLocalhost =
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:';
    allowed = isLocalhost || (host !== undefined && url.host === host);
  } catch {
    allowed = false; // Origin 解析失败按可疑处理
  }
  return allowed ? null : c.json({ error: 'forbidden_origin' }, 403);
}

/** 认证端点 body 上限（email+code+deviceHint 不过几百字节，64KB 已极宽裕）。 */
const MAX_AUTH_BODY_BYTES = 64 * 1024;

/**
 * Content-Length 尺寸闸门，先于 body 缓冲（同 knowledge.ts 的 OOM 防护）：
 * daemon 无鉴权，缺失/非法/超大的 Content-Length 一律 413，绝不让 c.req.json()
 * 把任意大的 body 读进内存。合法浏览器 JSON POST 必带 Content-Length。
 */
function denyOversizedBody(c: Context): Response | null {
  const rawLen = c.req.header('content-length');
  const contentLength = rawLen != null ? Number(rawLen) : NaN;
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_AUTH_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413);
  }
  return null;
}

async function readJsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}
