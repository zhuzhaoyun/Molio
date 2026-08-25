import { Hono, type Context } from 'hono';
import type { RefreshRequest, SendCodeRequest, UpdateMeRequest, VerifyRequest } from '@molio/contracts';
import type { CloudConfig } from './config.js';
import { corsMiddleware } from './cors.js';
import { verifyAccessToken, type AccessPayload } from './jwt.js';
import { marketRoutes, type MarketRoutesDeps } from './market/routes.js';
import { AuthService, ServiceError, type ServiceErrorStatus } from './service.js';

export interface AppDeps {
  service: AuthService;
  config: CloudConfig;
  storeKind: 'memory' | 'pg';
  /** 可注入时钟（与 service 同一时钟），测试用 */
  now: () => number;
  /** 资源市场：OSS 凭证齐全才装配；缺省 → /market 不挂载（404） */
  market?: MarketRoutesDeps;
}

// IPv4 点分十段；IPv6 宽松形态（hex/冒号，含 ::ffff:1.2.3.4 映射）。
// 校验格式防任意字符串被当作限频 key（撞库/大 key 撑爆索引）
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isValidIp(s: string): boolean {
  if (IPV4_RE.test(s)) {
    return s.split('.').every((seg) => Number(seg) <= 255);
  }
  return s.includes(':') && IPV6_RE.test(s);
}

function clientIp(c: Context): string | null {
  // FC/网关经 X-Forwarded-For 传真实 IP；本地直连为 null（本机调试不做 IP 限频）。
  // 注意：信任首值的前提是部署在会改写（而非追加）XFF 的网关之后（阿里云 FC 满足）；
  // 若将来直连暴露，必须改为校验直连方是否受信代理，否则 XFF 可伪造绕过 IP 限频。
  // prod 全量流量经 FC 网关必有 XFF；缺失/非法值回退 null = 只走邮箱维度限频（不拒绝请求，
  // 兼容 NAS/本地直连云的形态）
  const xff = c.req.header('x-forwarded-for');
  if (!xff) return null;
  const first = xff.split(',')[0]?.trim();
  if (!first || !isValidIp(first)) return null;
  return first;
}

/** 统一 JSON body 解析：非法/非对象 body 一律 null，各端点只做字段级类型校验 */
async function readJsonBody<T>(c: Context): Promise<T | null> {
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as T;
}

/**
 * 路由内错误归一：ServiceError → 结构化 JSON；其余异常兜底 internal/500（绝不让
 * Hono 默认纯文本 500 漏给客户端——daemon/web 只认 {error: code} 契约）。
 */
function handleError(c: Context, e: unknown): Response {
  if (e instanceof ServiceError) {
    return c.json({ error: e.code, ...e.extra }, e.status satisfies ServiceErrorStatus);
  }
  console.error('[cloud] unhandled route error:', e);
  return c.json({ error: 'internal' }, 500);
}

function bearer(c: Context, config: CloudConfig, now: () => number): AccessPayload | null {
  const header = c.req.header('authorization');
  // scheme 大小写不敏感（RFC 9110）：daemon 恒发 'Bearer '，宽松匹配只为兼容第三方调用
  if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return verifyAccessToken(header.slice(7), config.jwtSecret, Math.floor(now() / 1000));
}

/**
 * 云端认证服务（第一期 7 端点，§六）。
 * CORS 白名单（见 cors.ts）：官网静态页浏览器直连登录；
 * Molio 应用内 Web UI 仍一律经 daemon，不走这条路（§八修订）。
 */
export function createApp(deps: AppDeps): Hono {
  const { service, config } = deps;
  const app = new Hono();

  app.use('*', corsMiddleware(config));

  app.get('/health', (c) => c.json({ ok: true, env: config.env, store: deps.storeKind }));

  if (deps.market) {
    app.route('/market', marketRoutes(deps.market, config, deps.now));
  }

  app.post('/auth/send-code', async (c) => {
    const body = await readJsonBody<SendCodeRequest>(c);
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
    const body = await readJsonBody<VerifyRequest>(c);
    // 字段级校验分开报：格式错误是 400 请求错误，与 401「验证码不正确」语义不同
    if (!body || typeof body.email !== 'string') {
      return c.json({ error: 'invalid_email' }, 400);
    }
    if (typeof body.code !== 'string') {
      return c.json({ error: 'invalid_code' }, 400);
    }
    try {
      // deviceHint 收窄为 string：非字符串（对象/数组）流入 PG 参数序列化会 500
      const deviceHint = typeof body.deviceHint === 'string' ? body.deviceHint : undefined;
      const res = await service.verify(body.email, body.code, deviceHint);
      return c.json(res, 200);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post('/auth/refresh', async (c) => {
    const body = await readJsonBody<RefreshRequest>(c);
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

  app.patch('/auth/me', async (c) => {
    const payload = bearer(c, config, deps.now);
    if (!payload) return c.json({ error: 'invalid_token' }, 401);
    const body = await readJsonBody<UpdateMeRequest>(c);
    // nickname 必须为非空 string；长度/空白校验在 service（回结构化 invalid_nickname）
    if (!body || typeof body.nickname !== 'string') {
      return c.json({ error: 'invalid_nickname' }, 400);
    }
    try {
      return c.json(await service.updateMe(payload.sub, body.nickname), 200);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete('/auth/session', async (c) => {
    const payload = bearer(c, config, deps.now);
    if (!payload) return c.json({ error: 'invalid_token' }, 401);
    const body = await readJsonBody<{ refreshToken?: string }>(c);
    if (!body || typeof body.refreshToken !== 'string') {
      return c.json({ error: 'invalid_token' }, 401);
    }
    try {
      // 带上 payload.sub：只允许吊销调用者自己的 session（越权吊销他人 token 静默忽略）
      return c.json(await service.logout(payload.sub, body.refreshToken), 200);
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
