import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { hashPassword } from '../../src/core/access/password.js';
import { createSessionStore } from '../../src/core/access/sessions.js';
import { createAccessGuard } from '../../src/core/access/guard.js';
import { accessRoutes } from '../../src/routes/access.js';
import type { AccessConfig } from '../../src/core/access/config.js';

const origin = 'https://example.test';

test('server authenticates each request and requires origin and CSRF for writes', async () => {
  const db = new Database(':memory:');
  try {
    const hash = await hashPassword('long test password');
    const config: AccessConfig = { mode: 'server', host: '127.0.0.1', publicOrigin: origin, username: 'admin', passwordHash: hash };
    const store = createSessionStore(db, { credential: JSON.stringify([config.username, config.passwordHash]) });
    const app = new Hono();
    app.use('*', createAccessGuard(config, store));
    app.route('/api/access', accessRoutes(config, store));
    app.get('/api/config', (c) => c.json({ private: true }));
    app.get('/api/knowledge/vaults/:id/files/*', (c) => c.json({ ok: true }));
    app.post('/api/config', (c) => c.json({ ok: true }));
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    app.get('/api/public/site', (c) => c.json({ enabled: true }));
    app.get('/api/public/pages/:id', (c) => c.json({ id: c.req.param('id') }));
    app.get('/api/public/graph', (c) => c.json({ graph: true }));
    app.get('/api/public/assets/:id', (c) => c.body('asset'));
    app.post('/api/public/site', (c) => c.json({ write: true }));
    assert.equal((await app.request('/api/health', { method: 'HEAD' })).status, 200);
    for (const path of ['/api/public/site', '/api/public/pages/123e4567-e89b-42d3-a456-426614174000', '/api/public/graph', '/api/public/assets/123e4567-e89b-42d3-a456-426614174000']) {
      assert.equal((await app.request(path)).status, 200, `public read ${path}`);
      assert.equal((await app.request(path, { method: 'HEAD' })).status, 200, `public head ${path}`);
    }
    for (const path of ['/api/public/other', '/api/public/site/extra', '/api/public/pages/a%2Fb', '/api/public//graph', '/api/public/../config']) {
      assert.equal((await app.request(path)).status, 401, `unlisted public path ${path}`);
    }
    assert.equal((await app.request('/api/public/site', { method: 'POST' })).status, 401, 'public prefix does not allow writes');
    const anonymousSession = await app.request('/api/access/session');
    assert.deepEqual(await anonymousSession.json(), { mode: 'server', authenticated: false });
    assert.equal(anonymousSession.headers.get('cache-control'), 'no-store');
    assert.equal((await app.request('/api/config')).status, 401);
    const encodedApi = await app.request('/%61pi/config');
    assert.equal(encodedApi.status, 401);
    assert.equal(encodedApi.headers.get('cache-control'), 'no-store');
    assert.equal((await app.request('/api/access/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'long test password' }) })).status, 403);
    const login = await app.request('/api/access/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'long test password' }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie')!;
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /Secure/i); assert.match(setCookie, /SameSite=Lax/i);
    const cookie = setCookie.split(';')[0]!;
    const session = await app.request('/api/access/session', { headers: { cookie } });
    const state = await session.json() as { authenticated: boolean; csrfToken: string };
    assert.equal(state.authenticated, true); assert.ok(state.csrfToken);
    assert.equal((await app.request('/api/config', { headers: { cookie } })).status, 200);
    assert.equal((await app.request('/api/knowledge/vaults/a/files/%E4%B8%AD%E6%96%87.md', { headers: { cookie } })).status, 200);
    assert.equal((await app.request('/api/config', { method: 'POST', headers: { cookie, origin } })).status, 403);
    assert.equal((await app.request('/api/config', { method: 'POST', headers: { cookie, 'x-molio-csrf': state.csrfToken } })).status, 403);
    assert.equal((await app.request('/api/config', { method: 'POST', headers: { cookie, origin, 'x-molio-csrf': state.csrfToken } })).status, 200);
    assert.equal((await app.request('/api/access/logout', { method: 'POST', headers: { cookie, origin, 'x-molio-csrf': state.csrfToken } })).status, 204);
    assert.equal((await app.request('/api/config', { headers: { cookie } })).status, 401);
    for (const path of ['/api/public/vaults', '/api/access/login', '/api/config', '/api//config']) {
      assert.equal((await app.request(path)).status, 401, path);
    }
  } finally { db.close(); }
});
