import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthClient, AuthCloudError } from '../../../src/core/auth/auth-client.js';
import { readAuthTokens } from '../../../src/core/auth/token-store.js';
import { makeMockCloud, type MockCloud } from './mock-cloud.js';

/**
 * AuthClient 集成测试：mock 云端是行为可编程的（轮换/吊销/断网/5xx，见
 * mock-cloud.ts），不是只 mock 返回值。覆盖设计 §7.2/§7.3 与风险 D1：
 * 401→刷新→重试一次、并发 401 单飞、refresh 失效不盲试、<2min 主动刷新、
 * 云端不可达宽限、重启恢复。
 */
describe('AuthClient', () => {
  const NOW = 1_800_000_000_000;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalAuthUrl: string | undefined;
  let fakeNow: number;
  let mock: MockCloud;
  let client: AuthClient;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'molio-auth-client-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    originalAuthUrl = process.env.MOLIO_AUTH_URL;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.MOLIO_AUTH_URL;
    fakeNow = NOW;
    mock = makeMockCloud({ now: () => fakeNow });
    client = makeClient();
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

  function makeClient(overrides: Partial<ConstructorParameters<typeof AuthClient>[0]> = {}): AuthClient {
    return new AuthClient({
      baseUrl: mock.baseUrl,
      fetchImpl: mock.fetchImpl,
      now: () => fakeNow,
      retryDelaysMs: [], // 默认关退避等待；重试测试传 [0, 0] 保留重试次数
      ...overrides,
    });
  }

  function tokensOnDisk(): Record<string, unknown> | null {
    try {
      return JSON.parse(
        readFileSync(join(tempHome, '.molio', 'auth-tokens.json'), 'utf8'),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // ── 登录流程 ──────────────────────────────────────────────────────

  it('verify: token 落盘 + 尽力拉权益快照 + status 登录态', async () => {
    const res = await client.verify('user@example.com', '123456');
    assert.deepEqual(res.user, mock.user);

    const onDisk = tokensOnDisk();
    assert.ok(onDisk, 'tokens should be persisted');
    assert.equal(onDisk.refreshToken, 'refresh-1');
    assert.equal((onDisk.user as { email: string }).email, mock.user.email);
    assert.equal(typeof onDisk.accessExpiresAt, 'number');

    assert.equal(mock.countCalls('GET', '/auth/me'), 1, 'verify 后尽力拉一次快照');
    const snap = client.entitlementCache.read();
    assert.deepEqual(snap?.entitlement, { plan: 'free' });

    assert.deepEqual(await client.getStatus(), {
      loggedIn: true,
      configured: true,
      user: mock.user,
      entitlement: { plan: 'free' },
      stale: false,
    });
    assert.equal(client.isLoginExpired(), false);
  });

  it('sendCode: 云端响应原样透传（含 devCode）', async () => {
    const res = await client.sendCode('user@example.com');
    assert.deepEqual(res, { ok: true, resendAfterSec: 60, devCode: '123456' });
  });

  it('verify 4xx 透传且不重试（撞限频时重试有害）', async () => {
    mock.setVerifyOutcome('invalid_code');
    await assert.rejects(
      () => client.verify('user@example.com', '999999'),
      (e: AuthCloudError) => e.status === 401 && e.code === 'invalid_code',
    );
    assert.equal(mock.countCalls('POST', '/auth/verify'), 1);
    assert.equal(await readAuthTokens(), null, '失败的 verify 不落盘');
  });

  // ── 401 → 刷新 → 重试一次（§7.2） ─────────────────────────────────

  it('me 401 → refresh → 重试一次成功', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;
    mock.invalidateAccess(); // 本地看没过期，云端已失效

    const me = await client.me();
    assert.deepEqual(me.user, mock.user);
    assert.equal(mock.countCalls('POST', '/auth/refresh'), 1);
    assert.equal(mock.countCalls('GET', '/auth/me'), 2, '401 一次 + 重试一次');
    // 轮换后的新 refresh token 已落盘（旧 token 重放会被云端判泄漏）
    assert.equal((await readAuthTokens())?.refreshToken, 'refresh-2');
  });

  it('并发 me 撞 401 时 refresh 只发一次（single-flight，防 D1 轮换竞争）', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;
    mock.invalidateAccess();

    const [a, b] = await Promise.all([client.me(), client.me()]);
    assert.deepEqual(a.user, mock.user);
    assert.deepEqual(b.user, mock.user);
    assert.equal(mock.countCalls('POST', '/auth/refresh'), 1, '并发只刷一次');
    // 两个调用都拿到成功的 me 结果（各自重试或直接用新 token）
    assert.equal((await readAuthTokens())?.refreshToken, 'refresh-2');
  });

  it('refresh 被云端拒绝 → 清本地 + loginExpired，之后不盲试云端', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;
    mock.setRefreshOutcome('invalid');
    mock.invalidateAccess();

    await assert.rejects(
      () => client.me(),
      (e: AuthCloudError) => e.status === 401 && e.code === 'invalid_token',
    );

    assert.equal(await readAuthTokens(), null, 'token 已清');
    assert.equal(client.entitlementCache.read(), null, '权益快照已清');
    assert.equal(client.isLoginExpired(), true);
    assert.deepEqual(await client.getStatus(), { loggedIn: false, configured: true, loginExpired: true });

    // 关键负面断言：不再盲目打云端 refresh
    const refreshCalls = mock.countCalls('POST', '/auth/refresh');
    await assert.rejects(
      () => client.getAccessToken(),
      (e: AuthCloudError) => e.code === 'no_session',
    );
    assert.equal(mock.countCalls('POST', '/auth/refresh'), refreshCalls);
  });

  // ── 主动刷新（§7.2：<2min） ────────────────────────────────────────

  it('access 剩余寿命充足时 getAccessToken 不刷新', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;
    const token = await client.getAccessToken();
    assert.equal(token, (await readAuthTokens())?.accessToken);
    assert.equal(mock.countCalls('POST', '/auth/refresh'), 0);
  });

  it('access 剩余 <2min 时 getAccessToken 先刷新', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;
    const before = (await readAuthTokens())?.accessToken;

    fakeNow += (900 - 60) * 1000; // 剩 60s < 2min
    const token = await client.getAccessToken();

    assert.equal(mock.countCalls('POST', '/auth/refresh'), 1);
    assert.notEqual(token, before);
    assert.equal((await readAuthTokens())?.accessToken, token);
  });

  // ── 退避重试 ──────────────────────────────────────────────────────

  it('5xx 退避重试直到成功', async () => {
    const retryClient = makeClient({ retryDelaysMs: [0, 0] });
    mock.queue('POST', '/auth/send-code', { status: 500, body: {} });
    mock.queue('POST', '/auth/send-code', { status: 502, body: {} });
    const res = await retryClient.sendCode('user@example.com');
    assert.equal(res.ok, true);
    assert.equal(mock.countCalls('POST', '/auth/send-code'), 3);
  });

  it('网络错误退避重试直到成功，成功后 cloudState 恢复 ok', async () => {
    const retryClient = makeClient({ retryDelaysMs: [0, 0] });
    mock.queue('POST', '/auth/send-code', 'network-error');
    const res = await retryClient.sendCode('user@example.com');
    assert.equal(res.ok, true);
    assert.equal(mock.countCalls('POST', '/auth/send-code'), 2);
    assert.equal(retryClient.getCloudState(), 'ok');
  });

  // ── 云端不可达（§7.3 + local-first 红线） ─────────────────────────

  it('云端断网时 verify 报 cloud_unreachable 且不落盘', async () => {
    mock.setMode('down');
    await assert.rejects(
      () => client.verify('user@example.com', '123456'),
      (e: AuthCloudError) => e.status === 0 && e.code === 'cloud_unreachable',
    );
    assert.equal(client.getCloudState(), 'unreachable');
    assert.equal(await readAuthTokens(), null);
  });

  it('logout 云端不可达时本地仍登出成功（本地登出必须可用）', async () => {
    await client.verify('user@example.com', '123456');
    mock.setMode('down');
    await client.logout(); // 不抛
    assert.equal(await readAuthTokens(), null);
    assert.equal(client.entitlementCache.read(), null);
    assert.deepEqual(await client.getStatus(), { loggedIn: false, configured: true });
  });

  it('logout 云端可达时云端吊销 + 本地清除', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;
    await client.logout();
    assert.equal(mock.countCalls('DELETE', '/auth/session'), 1);
    const del = mock.lastCall('DELETE', '/auth/session');
    assert.equal((del?.body as { refreshToken?: string })?.refreshToken, 'refresh-1');
    assert.ok(del?.auth?.startsWith('Bearer '));
    assert.equal(await readAuthTokens(), null);
    assert.deepEqual(await client.getStatus(), { loggedIn: false, configured: true });
  });

  // ── 注销账号（§7.4 个保法；云端权威操作，与 logout 语义不同） ─────

  it('deleteAccount: 云端软删除 + 本地清除', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;
    await client.deleteAccount();
    assert.equal(mock.countCalls('DELETE', '/auth/account'), 1);
    assert.ok(mock.lastCall('DELETE', '/auth/account')?.auth?.startsWith('Bearer '));
    assert.equal(await readAuthTokens(), null);
    assert.equal(client.entitlementCache.read(), null);
    assert.deepEqual(await client.getStatus(), { loggedIn: false, configured: true });
  });

  it('deleteAccount 未登录 → no_session，不打云端', async () => {
    await assert.rejects(
      () => client.deleteAccount(),
      (e: AuthCloudError) => e.status === 0 && e.code === 'no_session',
    );
    assert.equal(mock.calls.length, 0);
  });

  it('deleteAccount 云端不可达 → 抛错且本地 token 保留（账号还在，供重试）', async () => {
    await client.verify('user@example.com', '123456');
    mock.setMode('down');
    await assert.rejects(
      () => client.deleteAccount(),
      (e: AuthCloudError) => e.status === 0 && e.code === 'cloud_unreachable',
    );
    assert.ok(await readAuthTokens(), 'token 保留，与 logout 的本地必清语义不同');
    assert.equal((await client.getStatus()).loggedIn, true);
  });

  it('deleteAccount 首次 401 → 刷新后重试一次成功', async () => {
    await client.verify('user@example.com', '123456');
    mock.invalidateAccess(); // 本地看没过期、云端已失效
    mock.calls.length = 0;
    await client.deleteAccount();
    assert.equal(mock.countCalls('POST', '/auth/refresh'), 1);
    assert.equal(mock.countCalls('DELETE', '/auth/account'), 2, '401 后重试一次');
    assert.equal(await readAuthTokens(), null);
  });

  // ── 启动恢复（§7.3） ──────────────────────────────────────────────

  it('重启恢复：refresh 验证 + 拉快照，轮换后新 token 落盘', async () => {
    await client.verify('user@example.com', '123456');
    mock.calls.length = 0;

    const restarted = makeClient(); // 模拟 daemon 重启（内存空，读盘）
    await restarted.restoreSession();

    assert.equal(mock.countCalls('POST', '/auth/refresh'), 1);
    assert.equal(mock.countCalls('GET', '/auth/me'), 1);
    assert.equal((await readAuthTokens())?.refreshToken, 'refresh-2', '轮换后的 token 落盘');
    const status = await restarted.getStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.stale, false);
    assert.deepEqual(status.entitlement, { plan: 'free' });
  });

  it('重启恢复时云端断网：保留 token，status stale=true，权益宽限内仍透出', async () => {
    await client.verify('user@example.com', '123456');
    mock.setMode('down');

    const restarted = makeClient();
    await restarted.restoreSession(); // 静默，不抛

    assert.ok(await readAuthTokens(), 'token 保留');
    assert.equal(restarted.getCloudState(), 'unreachable');
    const status = await restarted.getStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.stale, true);
    assert.deepEqual(status.entitlement, { plan: 'free' }, '宽限期内权益仍可用');
  });

  it('重启恢复时 refresh 被拒：清 token + loginExpired（不盲试）', async () => {
    await client.verify('user@example.com', '123456');
    mock.setRefreshOutcome('invalid');

    const restarted = makeClient();
    await restarted.restoreSession();

    assert.equal(await readAuthTokens(), null);
    assert.equal(restarted.isLoginExpired(), true);
    assert.deepEqual(await restarted.getStatus(), { loggedIn: false, configured: true, loginExpired: true });
  });

  it('从未登录时 restoreSession 零网络调用（存量用户零感知）', async () => {
    await makeClient().restoreSession();
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(await client.getStatus(), { loggedIn: false, configured: true });
  });

  // ── 配置 ──────────────────────────────────────────────────────────

  it('未配置 MOLIO_AUTH_URL：请求报 auth_not_configured，零网络调用', async () => {
    const unconfigured = new AuthClient({
      fetchImpl: mock.fetchImpl,
      now: () => fakeNow,
      retryDelaysMs: [],
    });
    assert.equal(unconfigured.isConfigured(), false);
    await assert.rejects(
      () => unconfigured.sendCode('user@example.com'),
      (e: AuthCloudError) => e.status === 503 && e.code === 'auth_not_configured',
    );
    assert.equal(mock.calls.length, 0);
  });

  it('baseUrl 缺省时懒读 env MOLIO_AUTH_URL', () => {
    process.env.MOLIO_AUTH_URL = 'http://env.cloud';
    const fromEnv = new AuthClient({ fetchImpl: mock.fetchImpl });
    assert.equal(fromEnv.getBaseUrl(), 'http://env.cloud');
    assert.equal(fromEnv.isConfigured(), true);
  });

  it('云端未配置但本地有 token：restoreSession 不做网络尝试，status 保留登录态', async () => {
    await client.verify('user@example.com', '123456');
    const unconfigured = new AuthClient({
      fetchImpl: mock.fetchImpl,
      now: () => fakeNow,
      retryDelaysMs: [],
    });
    mock.calls.length = 0;
    await unconfigured.restoreSession();
    assert.equal(mock.calls.length, 0);
    const status = await unconfigured.getStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.configured, false, 'Web UI 靠这个字段隐藏登录表单');
    assert.equal(status.stale, true, '未验证过云端 → stale');
  });
});
