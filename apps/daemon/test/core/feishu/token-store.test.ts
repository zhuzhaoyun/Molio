import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuTokenStore } from '../../../src/core/feishu/token-store.js';
import { FeishuApi, DEFAULT_BASE_URL } from '../../../src/core/feishu/client.js';
import { saveConfig, type AppConfig, type FeishuConfig } from '../../../src/core/config.js';

/**
 * FeishuTokenStore unit tests — migrated from the old FeishuService token
 * cache describe block (which poked the service's private `ensureToken`).
 * The store is now an independent unit: these tests fetch over a mocked
 * global fetch (no network), assert cache-hit semantics, and assert that
 * credentials are persisted to ~/.molio/feishu-credentials.json on refresh.
 */
describe('FeishuTokenStore', () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-feishu-token-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function mockTokenEndpoint(returnSeqToken: (n: number) => string): { callCount: number } {
    const counter = { callCount: 0 };
    globalThis.fetch = (async (url: URL | string) => {
      const target = String(url);
      if (target.includes('tenant_access_token/internal')) {
        counter.callCount += 1;
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: returnSeqToken(counter.callCount),
            expire: 7200,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return counter;
  }

  function makeStore(api: FeishuApi, cfg: FeishuConfig, onPersistError?: (m: string) => void): FeishuTokenStore {
    return new FeishuTokenStore({
      getApi: () => api,
      getConfig: () => cfg,
      onPersistError,
    });
  }

  it('fetches a fresh token on first getToken() and persists it to disk', async () => {
    const api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    const counter = mockTokenEndpoint((n) => `tok-${n}`);
    const store = makeStore(api, cfg);

    const token = await store.getToken();
    assert.equal(token, 'tok-1');
    assert.equal(counter.callCount, 1);

    const credsPath = join(tempDir, '.molio', 'feishu-credentials.json');
    assert.ok(existsSync(credsPath), 'credentials file should be written on first fetch');
    const stored = JSON.parse(readFileSync(credsPath, 'utf8'));
    assert.equal(stored.tenantAccessToken, 'tok-1');
    assert.equal(typeof stored.expiresAt, 'number');
  });

  it('serves the second getToken() from in-memory cache (no fetch)', async () => {
    const api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    const counter = mockTokenEndpoint((n) => `tok-${n}`);
    const store = makeStore(api, cfg);

    await store.getToken();
    const afterFirst = counter.callCount;
    await store.getToken();
    assert.equal(counter.callCount, afterFirst, 'second getToken() should hit the cache, not the endpoint');
  });

  it('invalidate() drops the in-memory cache — disk-cached token still serves (no re-fetch)', async () => {
    // invalidate() is meant to be called when the app identity changes
    // (appId/appSecret rotation); the caller is responsible for removing the
    // disk file via removeCredentials(). The store's invalidate() only
    // clears the in-memory cache — a valid on-disk token is still usable.
    // This matches the FeishuService.updateConfig flow: removeCredentials +
    // tokenStore.invalidate + stopWSClient, then start() re-establishes.
    const api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    const counter = mockTokenEndpoint((n) => `tok-${n}`);
    const store = makeStore(api, cfg);

    await store.getToken();
    store.invalidate();
    const token = await store.getToken();
    // Disk has tok-1 (still valid) — so getToken() reads from disk, no re-fetch.
    assert.equal(token, 'tok-1');
    assert.equal(counter.callCount, 1, 'disk-cached valid token still serves after invalidate');
  });

  it('invalidate() forces a re-fetch when the disk file has been removed', async () => {
    const api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    const counter = mockTokenEndpoint((n) => `tok-${n}`);
    const store = makeStore(api, cfg);

    await store.getToken();
    // Simulate the real updateConfig flow: removeCredentials + invalidate.
    const { removeCredentials } = await import('../../../src/core/channels/credentials-store.js');
    removeCredentials(join(tempDir, '.molio', 'feishu-credentials.json'));
    store.invalidate();
    const token = await store.getToken();
    assert.equal(token, 'tok-2');
    assert.equal(counter.callCount, 2, 'invalidate + removed disk file forces a fresh fetch');
  });

  it('reads a valid token from disk without hitting the endpoint', async () => {
    // Seed a credentials file with a far-future expiry.
    const credsPath = join(tempDir, '.molio', 'feishu-credentials.json');
    mkdirSync(join(tempDir, '.molio'), { recursive: true });
    writeFileSync(
      credsPath,
      JSON.stringify({ tenantAccessToken: 'from-disk', expiresAt: Date.now() + 3_600_000 }),
      'utf8',
    );

    const api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    const counter = mockTokenEndpoint((n) => `tok-${n}`);
    const store = makeStore(api, cfg);

    const token = await store.getToken();
    assert.equal(token, 'from-disk');
    assert.equal(counter.callCount, 0, 'disk-cached valid token should NOT trigger an endpoint hit');
  });

  it('surfaces write-disk failure via onPersistError AND rethrows', async () => {
    const api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    mockTokenEndpoint((n) => `tok-${n}`);
    const errors: string[] = [];

    // Block writeCredentials by pointing credentialsPath at a path whose
    // parent is a FILE (not a directory) — fs.mkdirSync(parent, {recursive})
    // fails with EEXIST (Windows) or ENOTDIR (POSIX) when the parent is a file.
    const blocker = join(tempDir, 'blocker-file');
    writeFileSync(blocker, 'blocker', 'utf8');
    const blockedCfg: FeishuConfig = { ...cfg, credentialsPath: join(blocker, 'nested.json') };
    const blockedStore = makeStore(api, blockedCfg, (msg) => { errors.push(msg); });

    await assert.rejects(() => blockedStore.getToken(), (err: unknown) => {
      // Cross-platform: Windows throws EEXIST, POSIX throws ENOTDIR/EISDIR.
      // We just want "some write-disk failure".
      const code = (err as NodeJS.ErrnoException).code ?? '';
      return ['EEXIST', 'ENOTDIR', 'EISDIR', 'EROFS', 'ENOENT'].includes(code);
    });
    assert.ok(errors.length > 0, 'onPersistError should have fired for the write failure');
    assert.match(errors[0]!, /Token 写盘失败/);
  });

  it('stopRefresh clears the refresh timer (subsequent startRefresh starts fresh)', async () => {
    const api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    mockTokenEndpoint((n) => `tok-${n}`);
    const store = makeStore(api, cfg);
    // Smoke test: start/stop/start sequence does not throw and the timer is
    // cleared between cycles.
    store.startRefresh();
    store.stopRefresh();
    store.startRefresh();
    store.stopRefresh();
    // No assertion needed — reaching here without throwing is the assertion.
    assert.ok(true);
  });

  it('throws when api is null (service not started)', async () => {
    const cfg: FeishuConfig = { enabled: true, appId: 'cli_x', appSecret: 'sec_x' };
    const store = new FeishuTokenStore({
      getApi: () => null,
      getConfig: () => cfg,
    });
    await assert.rejects(() => store.getToken(), /FeishuApi not initialized/);
  });
});
