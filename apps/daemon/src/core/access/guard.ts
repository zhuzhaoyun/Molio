import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AccessConfig } from './config.js';
import type { SessionStore } from './sessions.js';
import { wrapSessionStream } from './stream-lifetime.js';

export const ADMIN_COOKIE = '__Host-molio_admin';
export const csrfToken = (token: string): string => createHmac('sha256', token).update('molio-admin-csrf-v1').digest('hex');

export function createAccessGuard(config: AccessConfig, store: SessionStore | null): MiddlewareHandler {
  return async (c, next) => {
    if (config.mode === 'local') return next();
    // Reject encoded/ambiguous API paths before route matching can normalize them differently.
    const path = new URL(c.req.url).pathname;
    const decoded = (() => { try { return decodeURIComponent(path); } catch { return ''; } })();
    if (!decoded) return c.json({ error: 'bad_request' }, 400);
    const api = decoded === '/api' || decoded.startsWith('/api/') || decoded.startsWith('//api/');
    if (!api) return next();
    c.header('Cache-Control', 'no-store');
    if ((!path.startsWith('/api/') && path !== '/api') || path.includes('//') || path.includes('\\')) return c.json({ error: 'unauthorized' }, 401);
    const method = c.req.method;
    const isHealth = path === '/api/health' && (method === 'GET' || method === 'HEAD');
    const isSession = path === '/api/access/session' && method === 'GET';
    const isLogin = path === '/api/access/login' && method === 'POST';
    if (isHealth || isSession || isLogin) {
      if (isLogin && c.req.header('origin') !== config.publicOrigin) return c.json({ error: 'forbidden' }, 403);
      await next();
      if (!isHealth) c.res.headers.set('Cache-Control', 'no-store');
      return;
    }
    const token = getCookie(c, ADMIN_COOKIE);
    const session = token && store?.verify(token);
    if (!token || !session) return c.json({ error: 'unauthorized' }, 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const supplied = c.req.header('x-molio-csrf') ?? '';
      const expected = csrfToken(token);
      if (c.req.header('origin') !== config.publicOrigin || !/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    await next();
    if (store && c.res.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      c.res = wrapSessionStream(c.res, session, store, () => !!store.verify(token), c.req.raw.signal);
    }
    c.res.headers.set('Cache-Control', 'no-store');
  };
}
