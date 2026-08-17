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
 * - 注销账号是云端权威操作：断网抛 502 且本地 token 保留（与 logout 语义不同）
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

  // WHATWG Request（app.request 的底座）不会自动生成 content-length 头，
  // 而路由对 /start /verify 有"缺失/超大 CL → 413"的 OOM 闸门，故此处显式带上。
  async function post(path: string, body: unknown): Promise<Response> {
    const text = JSON.stringify(body);
    return app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
      },
      body: text,
    });
  }

  /** 同 post：PATCH /me 同样过 OOM 闸门，必须带 content-length。 */
  async function patchReq(path: string, body: unknown): Promise<Response> {
    const text = JSON.stringify(body);
    return app.request(path, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
      },
      body: text,
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

    it('云端 422 mail_failed 原样透传（发信通道失败，4xx 不重试）', async () => {
      mock.queue('POST', '/auth/send-code', {
        status: 422,
        body: { error: 'mail_failed' },
      });
      const res = await post('/api/auth/start', { email: 'user@example.com' });
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { error: 'mail_failed' });
      assert.equal(mock.countCalls('POST', '/auth/send-code'), 1, '只请求一次，不重试');
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

  describe('PATCH /me（修改昵称）', () => {
    it('登录后改昵称 → 200 MeResponse，status 立刻反映新昵称', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      const res = await patchReq('/api/auth/me', { nickname: '墨流君' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal((body.user as { nickname: string }).nickname, '墨流君');
      assert.deepEqual(body.entitlement, { plan: 'free' });
      assert.equal(mock.countCalls('PATCH', '/auth/me'), 1);

      // 本地快照同步：status 不发网络请求即可看到新昵称
      const status = await app.request('/api/auth/status');
      const sBody = (await status.json()) as Record<string, unknown>;
      assert.equal((sBody.user as { nickname: string }).nickname, '墨流君');
    });

    it('未登录 → 401 no_session，不打云端', async () => {
      const res = await patchReq('/api/auth/me', { nickname: '墨流君' });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'no_session' });
      assert.equal(mock.calls.length, 0);
    });

    it('nickname 非 string → 400 invalid_nickname，不打云端', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      mock.calls.length = 0;
      const res = await patchReq('/api/auth/me', { nickname: 12345 });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_nickname' });
      assert.equal(mock.calls.length, 0);
    });

    it('云端 400 原样透传（超长等校验由云端权威判定）', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      mock.queue('PATCH', '/auth/me', {
        status: 400,
        body: { error: 'invalid_nickname' },
      });
      const res = await patchReq('/api/auth/me', { nickname: 'x'.repeat(21) });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_nickname' });
    });

    it('云端断网 → 502 cloud_unreachable，本地登录态保留', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      mock.setMode('down');
      const res = await patchReq('/api/auth/me', { nickname: '墨流君' });
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'cloud_unreachable' });

      const status = await app.request('/api/auth/status');
      assert.equal(
        ((await status.json()) as { loggedIn: boolean }).loggedIn,
        true,
        '改昵称失败不影响登录态',
      );
    });
  });

  describe('GET /status', () => {
    it('未登录 → {loggedIn:false}', async () => {
      const res = await app.request('/api/auth/status');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { loggedIn: false, configured: true });
    });

    it('登录后 → loggedIn + user + stale:false + configured', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      const res = await app.request('/api/auth/status');
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.loggedIn, true);
      assert.equal(body.configured, true);
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
      assert.deepEqual(await status.json(), { loggedIn: false, configured: true });
    });

    it('云端断网也登出成功（本地必清）', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      mock.setMode('down');
      const res = await post('/api/auth/logout', {});
      assert.equal(res.status, 200);
      const status = await app.request('/api/auth/status');
      assert.deepEqual(await status.json(), { loggedIn: false, configured: true });
    });
  });

  describe('DELETE /account（注销账号，§7.4）', () => {
    async function del(path: string): Promise<Response> {
      return app.request(path, { method: 'DELETE' });
    }

    it('登录后注销 → {ok:true}，status 回未登录（configured 仍 true）', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      const res = await del('/api/auth/account');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(mock.countCalls('DELETE', '/auth/account'), 1);

      const status = await app.request('/api/auth/status');
      assert.deepEqual(await status.json(), { loggedIn: false, configured: true });
    });

    it('未登录 → 401 no_session，不打云端', async () => {
      const res = await del('/api/auth/account');
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'no_session' });
      assert.equal(mock.calls.length, 0);
    });

    it('云端断网 → 502 cloud_unreachable，本地登录态保留（与 logout 不同）', async () => {
      await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      mock.setMode('down');
      const res = await del('/api/auth/account');
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'cloud_unreachable' });

      const status = await app.request('/api/auth/status');
      assert.equal(
        ((await status.json()) as { loggedIn: boolean }).loggedIn,
        true,
        '账号还在云端，token 保留供重试',
      );
    });
  });

  it('MOLIO_AUTH_URL 未配置 → 503 auth_not_configured', async () => {
    const unconfigured = new AuthClient({ fetchImpl: mock.fetchImpl, retryDelaysMs: [] });
    const bareApp = new Hono();
    bareApp.route('/api/auth', authRoutes(unconfigured));
    const text = JSON.stringify({ email: 'user@example.com' });
    const res = await bareApp.request('/api/auth/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
      },
      body: text,
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'auth_not_configured' });
  });

  describe('CSRF：写端点 Origin 白名单（远程页面不得驱动登录/登出）', () => {
    async function withOrigin(
      method: string,
      path: string,
      origin: string,
      body?: unknown,
    ): Promise<Response> {
      const text = body !== undefined ? JSON.stringify(body) : undefined;
      return app.request(path, {
        method,
        headers: {
          'content-type': 'application/json',
          origin,
          host: 'localhost:3100',
          ...(text !== undefined ? { 'content-length': String(Buffer.byteLength(text)) } : {}),
        },
        ...(text !== undefined ? { body: text } : {}),
      });
    }

    it('远程 Origin → 403 forbidden_origin，不打云端', async () => {
      const res = await withOrigin('POST', '/api/auth/logout', 'http://evil.example.com', {});
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'forbidden_origin' });
      assert.equal(mock.calls.length, 0, '拒绝必须先于任何副作用');
      const start = await withOrigin('POST', '/api/auth/start', 'https://evil.example.com', {
        email: 'user@example.com',
      });
      assert.equal(start.status, 403);
      const del = await app.request('/api/auth/account', {
        method: 'DELETE',
        headers: { origin: 'http://evil.example.com', host: 'localhost:3100' },
      });
      assert.equal(del.status, 403);
    });

    it('dev 拓扑放行：vite(localhost:5173) → daemon(localhost:3100)', async () => {
      const res = await withOrigin('POST', '/api/auth/start', 'http://localhost:5173', {
        email: 'user@example.com',
      });
      assert.equal(res.status, 202);
    });

    it('同源放行：Origin host 与 Host 头一致（NAS/生产 web 由 daemon 伺服）', async () => {
      const text = JSON.stringify({ email: 'user@example.com' });
      const res = await app.request('/api/auth/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://molio.local:3100',
          host: 'molio.local:3100',
          'content-length': String(Buffer.byteLength(text)),
        },
        body: text,
      });
      assert.equal(res.status, 202);
    });

    it('无 Origin（curl/非浏览器）放行；Origin 解析失败拒绝', async () => {
      const res = await post('/api/auth/start', { email: 'user@example.com' });
      assert.equal(res.status, 202);
      // URL 构造失败的畸形 Origin
      const evil = await app.request('/api/auth/logout', {
        method: 'POST',
        headers: { origin: 'not a url', host: 'localhost:3100' },
      });
      assert.equal(evil.status, 403);
    });
  });

  describe('body 尺寸闸门（daemon 无鉴权，防 OOM）', () => {
    it('超大 body → 413 payload_too_large（body 不被缓冲进云端调用）', async () => {
      const res = await post('/api/auth/start', { email: `a@${'x'.repeat(70_000)}.com` });
      assert.equal(res.status, 413);
      assert.deepEqual(await res.json(), { error: 'payload_too_large' });
      assert.equal(mock.calls.length, 0);
    });

    it('Content-Length 缺失/非法 → 413（同 knowledge.ts：绝不先缓冲再检查）', async () => {
      const missing = await app.request('/api/auth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' }),
      });
      assert.equal(missing.status, 413);
      const spoofed = await app.request('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 'not-a-number' },
        body: JSON.stringify({ email: 'user@example.com', code: '1' }),
      });
      assert.equal(spoofed.status, 413);
      assert.equal(mock.calls.length, 0);
    });

    it('正常小 body 不受影响', async () => {
      const res = await post('/api/auth/verify', { email: 'user@example.com', code: '123456' });
      assert.equal(res.status, 200);
    });
  });

  it('GET /status 内部异常 → 500 internal（不透栈）', async () => {
    const broken = {
      getStatus: async () => {
        throw new Error('disk exploded');
      },
    } as unknown as AuthClient;
    const bareApp = new Hono();
    bareApp.route('/api/auth', authRoutes(broken));
    const res = await bareApp.request('/api/auth/status');
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal' });
  });
});
