import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AccessConfig } from '../core/access/config.js';
import type { SessionStore } from '../core/access/sessions.js';
import { verifyPassword } from '../core/access/password.js';
import { ADMIN_COOKIE, csrfToken } from '../core/access/guard.js';

const cookieOptions = { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const };

async function readBody(c: Context): Promise<unknown> {
  const declared = c.req.header('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw new Error('size');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); throw new Error('size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function accessRoutes(config: AccessConfig, store: SessionStore | null): Hono {
  const app = new Hono();
  let attempts: number[] = [];
  let active = 0;

  app.get('/session', (c) => {
    if (config.mode === 'local') return c.json({ mode: 'local', authenticated: false });
    const token = getCookie(c, ADMIN_COOKIE);
    const session = token && store?.verify(token);
    return session && token
      ? c.json({ mode: 'server', authenticated: true, expiresAt: session.expiresAt, csrfToken: csrfToken(token) })
      : c.json({ mode: 'server', authenticated: false });
  });

  app.post('/login', async (c) => {
    if (config.mode === 'local' || !store) return c.json({ error: 'local_mode_no_login' }, 409);
    if (c.req.header('origin') !== config.publicOrigin) return c.json({ error: 'forbidden' }, 403);
    attempts = attempts.filter((when) => when > Date.now() - 60_000);
    if (attempts.length >= 5 || active >= 2) { c.header('Retry-After', '60'); return c.json({ error: 'rate_limited' }, 429); }
    let body: unknown;
    try { body = await readBody(c); } catch (err) { return c.json({ error: err instanceof Error && err.message === 'size' ? 'payload_too_large' : 'invalid_request' }, err instanceof Error && err.message === 'size' ? 413 : 400); }
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid_request' }, 400);
    const { username, password } = body as Record<string, unknown>;
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || username.trim().length > 128 || !password || Buffer.byteLength(password) > 1024) return c.json({ error: 'invalid_request' }, 400);
    // Count pending attempts towards the limit, so concurrent requests cannot bypass it.
    if (attempts.length + active >= 5 || active >= 2) { c.header('Retry-After', '60'); return c.json({ error: 'rate_limited' }, 429); }
    active++;
    let valid: boolean;
    try {
      const a = createHash('sha256').update(username.trim()).digest();
      const b = createHash('sha256').update(config.username).digest();
      valid = await verifyPassword(password, config.passwordHash) && timingSafeEqual(a, b);
    } finally { active--; }
    if (!valid) { attempts.push(Date.now()); return c.json({ error: 'unauthorized' }, 401); }
    const session = store.create();
    setCookie(c, ADMIN_COOKIE, session.token, { ...cookieOptions, maxAge: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)) });
    return c.json({ authenticated: true, expiresAt: session.expiresAt });
  });

  app.post('/logout', (c) => {
    if (config.mode === 'local' || !store) return c.json({ error: 'local_mode_no_login' }, 409);
    const token = getCookie(c, ADMIN_COOKIE);
    if (token) store.revoke(token);
    deleteCookie(c, ADMIN_COOKIE, cookieOptions);
    return c.body(null, 204);
  });
  return app;
}
