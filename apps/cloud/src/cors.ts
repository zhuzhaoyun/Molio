/**
 * CORS 白名单（官网静态页浏览器直连登录的第一个开口，设计 §八修订）。
 *
 * 原则：
 * - **只回 CORS 头 + 短路 OPTIONS**，不动任何业务逻辑。
 * - 命中白名单 → `Access-Control-Allow-Origin` 回显该 origin（**不用 `*`**，
 *   白名单语义可审计，且为将来带 credentials 留正确形状）。
 * - 未命中 → 不下发任何 CORS 头（服务端照常处理请求，仅浏览器侧拦截——
 *   限频/审计不依赖 CORS，直接拒绝反而丢失探测信息）。
 * - **不下发 `Access-Control-Allow-Credentials`**：token 走 Authorization 头/响应体，
 *   无 cookie，天然免疫 CSRF；不引入 credentials 语义就永远不会意外引入。
 * - 所有响应带 `Vary: Origin`：响应内容随 Origin 变化，缓存必须按源区分。
 */
import type { MiddlewareHandler } from 'hono';
import type { CloudConfig } from './config.js';

/** 官网正式域名（生产白名单基线） */
const PROD_ORIGINS = ['https://molio.cn', 'https://www.molio.cn'];

export function isOriginAllowed(config: CloudConfig, origin: string): boolean {
  if (PROD_ORIGINS.includes(origin)) return true;
  if (config.corsExtraOrigins.includes(origin)) return true;
  // daily/local：放开本机任意端口，联调/官网本地预览用；prod 严格不放
  if (config.env !== 'prod') {
    try {
      const url = new URL(origin);
      if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        return true;
      }
    } catch {
      // origin 非法 → 不允许
    }
  }
  return false;
}

export function corsMiddleware(config: CloudConfig): MiddlewareHandler {
  return async (c, next) => {
    c.header('Vary', 'Origin');
    const origin = c.req.header('origin');
    if (origin && isOriginAllowed(config, origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      if (c.req.method === 'OPTIONS') {
        c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        c.header('Access-Control-Allow-Headers', 'content-type, authorization');
        c.header('Access-Control-Max-Age', '600');
        return c.body(null, 204);
      }
    } else if (c.req.method === 'OPTIONS') {
      // 非白名单预检同样短路：不落业务路由（也没有业务路由接 OPTIONS）
      return c.body(null, 204);
    }
    await next();
  };
}
