import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { hashPassword } from '../../src/core/access/password.js';
import { createSessionStore } from '../../src/core/access/sessions.js';
import { createAccessGuard } from '../../src/core/access/guard.js';
import { accessRoutes } from '../../src/routes/access.js';
import type { AccessConfig } from '../../src/core/access/config.js';

const origin = 'https://example.test';
async function fixture() {
  const db = new Database(':memory:');
  const hash = await hashPassword('long test password');
  const config: AccessConfig = { mode: 'server', host: '127.0.0.1', publicOrigin: origin, username: 'admin', passwordHash: hash };
  const store = createSessionStore(db, { credential: JSON.stringify([config.username, hash]) });
  const app = new Hono(); app.use('*', createAccessGuard(config, store)); app.route('/api/access', accessRoutes(config, store));
  return { db, app, store };
}
const login = (app: Hono, username: string, password: string) => app.request('/api/access/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });

test('login bounds request body and checks Origin even without Content-Length', async () => {
  const { db, app } = await fixture();
  try {
    const body = JSON.stringify({ username: 'admin', password: 'a'.repeat(5000) });
    const res = await app.request('/api/access/login', { method: 'POST', headers: { origin }, body });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await app.request('/api/access/login', { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await login(app, '', 'a')).status, 400);
  } finally { db.close(); }
});

test('failed login attempts are limited across usernames, without leaking credentials', async () => {
  const { db, app } = await fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await login(app, `user${i}`, 'incorrect password');
      assert.equal(res.status, 401);
      const body = await res.text();
      assert.equal(body.includes('incorrect password'), false);
      assert.equal(res.headers.get('set-cookie'), null);
    }
    const limited = await login(app, 'admin', 'long test password');
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
  } finally { db.close(); }
});

test('local authentication endpoints do not create a session', async () => {
  const config: AccessConfig = { mode: 'local', host: '127.0.0.1' };
  const app = new Hono(); app.use('*', createAccessGuard(config, null)); app.route('/api/access', accessRoutes(config, null));
  assert.deepEqual(await (await app.request('/api/access/session')).json(), { mode: 'local', authenticated: false });
  assert.equal((await app.request('/api/access/login', { method: 'POST' })).status, 409);
  assert.equal((await app.request('/api/access/logout', { method: 'POST' })).status, 409);
});

test('no more than two password verifications run concurrently', async () => {
  const { db, app } = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 3 }, () => login(app, 'admin', 'long test password')));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 429]);
  } finally { db.close(); }
});

test('login cookie max age follows the remaining absolute session lifetime', async () => {
  const db = new Database(':memory:');
  try {
    const hash = await hashPassword('long test password');
    const config: AccessConfig = { mode: 'server', host: '127.0.0.1', publicOrigin: origin, username: 'admin', passwordHash: hash };
    const actual = createSessionStore(db, { credential: 'test' });
    const store = { ...actual, create: () => ({ ...actual.create(), expiresAt: Date.now() + 10_000 }) };
    const app = new Hono(); app.use('*', createAccessGuard(config, store)); app.route('/api/access', accessRoutes(config, store));
    const response = await login(app, 'admin', 'long test password');
    assert.equal(response.status, 200);
    const maxAge = Number(response.headers.get('set-cookie')?.match(/Max-Age=(\d+)/i)?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 10, `unexpected cookie max age: ${maxAge}`);
  } finally { db.close(); }
});
