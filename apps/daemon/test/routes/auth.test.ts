import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthClient } from '../../src/core/auth/auth-client.js';
import { authRoutes } from '../../src/routes/auth.js';
import { makeMockCloud, type MockCloud } from '../core/auth/mock-cloud.js';

/**
 * /api/auth 本地镜像端点（设计 §六）。重点：
 * - start 原样透传云端响应（含 daily 的 devCode，M3 E2E 取码用）
 * - 云端错误码透传（429 rate_limited 带 resendAfterSec）
 * - 断网 → 502 cloud_unreachable；未配置 → 503 auth_not_configured
 * - logout 本地必成功（local-first 红线）
 */
describe('auth routes', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalAuthUrl: string | undefined;
  let mock: MockCloud;
  let client: AuthClient;
  let app: Hono;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'molio-auth-routes-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    originalAuthUrl = process.env.MOLIO_AUTH_URL;
    delete process.env.MOLIO_AUTH_URL;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    mock = makeMockCloud();
    client = new AuthClient({
      baseUrl: mock.baseUrl,
      fetchImpl: mock.fetchImpl,
      retryDelaysMs: [],
    });
    app = new Hono();
    app.route('/api/auth', authRoutes(client));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    if (originalAuthUrl === undefined) delete process.env.MOLIO_AUTH_URL;
    else process.env.MOLIO_AUTH_URL = originalAuthUrl;
    rmSync(tempHome, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  describe('POST /start', () => {
    it('透传云端 202 响应（含 devCode）', async () => {
      const res = await post('/api/auth/start', { email: 'user@example.com' });
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), {
        ok: true,
        resendAfterSec: 60,
        devCode: '123456',
      });
    });

    it('邮箱缺失 → 400 invalid_email，不打云端', async () => {
      const res = await post('/api/auth/start', {});
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_email' });
      assert.equal(mock.calls.length, 0);
    });

    it('云端 429 rate_limited 原样透传（含 resendAfterSec）', async () => {
      mock.queue('POST', '/auth/send-code', {
        status: 429,
        body: { error: 'rate_limited', resendAfterSec: 42 },
      });
      const res = await post('/api/auth/start', { email: 'user@example.com' });
      assert.equal(res.status, 429);
      assert.deepEqual(await res.json(), { error: 'rate_limited', resendAfterSec: 42 });
    });

    it('云端断网 → 502 cloud_unreachable', async () => {
      mock.setMode('down');
      const res = await post('/api/auth/start', { email: 'user@example.com' });
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'cloud_unreachable' });
    });
  });

  describe('POST /verify', () => {
    it('登录成功 → {user, loggedIn:true}', async () => {
      const res = await post('/api/auth/verify', {
        email: 'user@example.com',
        code: '123456',
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.loggedIn, true);
      assert.deepEqual(body.user, mock.user);
    });

    it('验证码错误 → 401 invalid_code 透传', async () => {
      mock.setVerifyOutcome('invalid_code');
      const res = await post('/api/auth/verify', {
        email: 'user@example.com',
        code: '999999',
      });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'invalid_code' });
    });

    it('字段缺失 → 400，不打云端', async () => {
      const res = await post('/api/auth/verify', { email: 'user@example.com' });
      assert.equal(res.status, 400);
      assert.equal(mock.calls.length, 0);
    });
  });

  describe('GET /status', () => {
    it('未登录 → {loggedIn:false}', async () => {
      const res = await app.request('/api/auth/status');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { loggedIn: false });
    });

    it('登录后 → loggedIn + user + stale:false', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      const res = await app.request('/api/auth/status');
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.loggedIn, true);
      assert.equal(body.stale, false);
      assert.deepEqual(body.user, mock.user);
      assert.deepEqual(body.entitlement, { plan: 'free' });
    });
  });

  describe('POST /logout', () => {
    it('登出后 status 回未登录', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      const res = await post('/api/auth/logout', {});
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(mock.countCalls('DELETE', '/auth/session'), 1);

      const status = await app.request('/api/auth/status');
      assert.deepEqual(await status.json(), { loggedIn: false });
    });

    it('云端断网也登出成功（本地必清）', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      mock.setMode('down');
      const res = await post('/api/auth/logout', {});
      assert.equal(res.status, 200);
      const status = await app.request('/api/auth/status');
      assert.deepEqual(await status.json(), { loggedIn: false });
    });
  });

  it('MOLIO_AUTH_URL 未配置 → 503 auth_not_configured', async () => {
    const unconfigured = new AuthClient({ fetchImpl: mock.fetchImpl, retryDelaysMs: [] });
    const bareApp = new Hono();
    bareApp.route('/api/auth', authRoutes(unconfigured));
    const res = await bareApp.request('/api/auth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'auth_not_configured' });
  });
});
