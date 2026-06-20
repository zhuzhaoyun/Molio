import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { WeixinService } from '../../../src/core/weixin/service.js';
import { ConversationService } from '../../../src/core/conversations/service.js';
import { WeixinApi } from '../../../src/core/weixin/client.js';
import type { RunManager } from '../../../src/core/RunManager.js';
import type { ConnectionState } from '../../../src/core/weixin/types.js';

/** Minimal mock of RunManager — only the methods WeixinService uses. */
function createMockRunManager(): RunManager {
  return {
    createRun: async () => 'mock-run-id',
    onEvent: () => () => {},
    cancelAll: () => {},
  } as unknown as RunManager;
}

/** Write a fake credentials file so start() finds it. */
function writeFakeCredentials(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'weixin-credentials.json'),
    JSON.stringify({
      token: 'test-token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'test-bot',
      userId: 'test-user',
      contextTokens: {},
    }),
    'utf8',
  );
}

/** Wait for async state transitions to settle. */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WeixinService state machine — basics', () => {
  let db: Database.Database;
  let tempDir: string;
  let service: WeixinService;
  let conversations: ConversationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-sm-test-'));
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
    service = new WeixinService(createMockRunManager(), conversations, db);
  });

  afterEach(() => {
    service.stop();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts in idle state', () => {
    const status = service.getStatus();
    assert.equal(status.connectionState, 'idle');
    assert.equal(status.connected, false);
  });

  it('stop() transitions to idle and cleans up', () => {
    const status = service.stop();
    assert.equal(status.connectionState, 'idle');
    assert.equal(status.connected, false);
    assert.equal(status.loginStatus, 'idle');
  });

  it('start() without credentials stays idle', async () => {
    const status = await service.start();
    assert.equal(status.connectionState, 'idle');
    assert.equal(status.connected, false);
  });

  it('disconnect() clears credentials and disables', () => {
    const status = service.disconnect();
    assert.equal(status.connectionState, 'idle');
    assert.equal(status.enabled, false);
  });

  it('getStatus() exposes connectionState field', () => {
    const status = service.getStatus();
    assert.ok('connectionState' in status);
    assert.equal(typeof status.connectionState, 'string');
  });

  it('multiple stop() calls are idempotent', () => {
    service.stop();
    service.stop();
    const status = service.stop();
    assert.equal(status.connectionState, 'idle');
  });
});

describe('WeixinService state machine — integration', () => {
  let db: Database.Database;
  let tempDir: string;
  let configDir: string;
  let service: WeixinService;
  let conversations: ConversationService;

  // Track mock behavior
  let getUpdatesCallCount: number;
  let getUpdatesShouldFail: boolean;
  let getUpdatesFailWithExpired: boolean;
  let healthCheckResult: boolean;
  let originalGetUpdates: typeof import('../../../src/core/weixin/client.js').WeixinApi.prototype.getUpdates;
  let originalHealthCheck: typeof import('../../../src/core/weixin/client.js').WeixinApi.prototype.healthCheck;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-int-test-'));
    configDir = join(tempDir, '.molio');
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
    service = new WeixinService(createMockRunManager(), conversations, db);

    // Reset mock state
    getUpdatesCallCount = 0;
    getUpdatesShouldFail = false;
    getUpdatesFailWithExpired = false;
    healthCheckResult = true;

    // Monkey-patch WeixinApi prototype to intercept network calls.
    // This is necessary because WeixinService creates WeixinApi internally
    // and we can't inject a mock through the constructor.
    originalGetUpdates = WeixinApi.prototype.getUpdates;
    originalHealthCheck = WeixinApi.prototype.healthCheck;

    WeixinApi.prototype.getUpdates = async function () {
      getUpdatesCallCount++;
      if (getUpdatesFailWithExpired) {
        return { ret: -14, errcode: -14, errmsg: 'session expired' };
      }
      if (getUpdatesShouldFail) {
        throw new Error('Network error: ECONNRESET');
      }
      // Simulate long-polling: return empty response after a short delay.
      await new Promise((r) => setTimeout(r, 10));
      return { ret: 0, errcode: 0, msgs: [], get_updates_buf: '' };
    };

    WeixinApi.prototype.healthCheck = async function () {
      return healthCheckResult;
    };
  });

  afterEach(() => {
    service.stop();

    // Restore original methods
    WeixinApi.prototype.getUpdates = originalGetUpdates;
    WeixinApi.prototype.healthCheck = originalHealthCheck;

    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('start() with valid credentials transitions to polling', async () => {
    writeFakeCredentials(configDir);

    // Patch getConfig to use our temp config dir
    const origGetConfig = (service as any).getConfig.bind(service);
    (service as any).getConfig = () => ({ enabled: true, credentialsPath: join(configDir, 'weixin-credentials.json') });

    const status = await service.start();

    // Should transition through connecting → polling
    assert.equal(status.connectionState, 'polling');
    assert.equal(status.connected, true);
    assert.equal(status.loginStatus, 'logged_in');

    // Give pollLoop time to make at least one call
    await settle(50);
    assert.ok(getUpdatesCallCount >= 1, `Expected at least 1 getUpdates call, got ${getUpdatesCallCount}`);
  });

  it('pollLoop failure transitions to unhealthy (not infinite retry)', async () => {
    writeFakeCredentials(configDir);
    (service as any).getConfig = () => ({ enabled: true, credentialsPath: join(configDir, 'weixin-credentials.json') });

    // Make getUpdates fail immediately
    getUpdatesShouldFail = true;

    await service.start();
    // pollLoop should have tried once, failed, and transitioned to unhealthy
    await settle(100);

    const status = service.getStatus();
    assert.equal(status.connectionState, 'unhealthy');
    assert.equal(status.connected, false);
    assert.ok(status.lastError?.includes('ECONNRESET'));

    // Critically: it should NOT keep retrying blindly.
    // After transitioning to unhealthy, no more getUpdates calls should happen.
    const countAfterUnhealthy = getUpdatesCallCount;
    await settle(200);
    assert.equal(
      getUpdatesCallCount,
      countAfterUnhealthy,
      'pollLoop should not retry after transitioning to unhealthy',
    );
  });

  it('session expired (-14) transitions to expired and stops probing', async () => {
    writeFakeCredentials(configDir);
    (service as any).getConfig = () => ({ enabled: true, credentialsPath: join(configDir, 'weixin-credentials.json') });

    getUpdatesFailWithExpired = true;

    await service.start();
    await settle(100);

    const status = service.getStatus();
    assert.equal(status.connectionState, 'expired');
    assert.equal(status.connected, false);
    assert.equal(status.loginStatus, 'error');
    assert.ok(status.lastError?.includes('session expired'));
  });

  it('health probe detects recovery and restarts polling', async () => {
    writeFakeCredentials(configDir);
    (service as any).getConfig = () => ({ enabled: true, credentialsPath: join(configDir, 'weixin-credentials.json') });

    // Start normally, then force into unhealthy
    getUpdatesShouldFail = true;
    await service.start();
    await settle(100);

    assert.equal(service.getStatus().connectionState, 'unhealthy');
    const callsBeforeRecovery = getUpdatesCallCount;

    // Simulate network recovery
    getUpdatesShouldFail = false;
    healthCheckResult = true;

    // Manually trigger a health probe tick instead of waiting 30s
    await (service as any).runHealthProbe();
    await settle(100);

    const status = service.getStatus();
    assert.equal(status.connectionState, 'polling', 'Should recover to polling after successful health probe');
    assert.equal(status.connected, true);
    assert.ok(getUpdatesCallCount > callsBeforeRecovery, 'Should resume getUpdates after recovery');
  });

  it('health probe detects silent hang during polling', async () => {
    writeFakeCredentials(configDir);
    (service as any).getConfig = () => ({ enabled: true, credentialsPath: join(configDir, 'weixin-credentials.json') });

    // Start normally — getUpdates succeeds
    await service.start();
    await settle(50);
    assert.equal(service.getStatus().connectionState, 'polling');

    // Now simulate network going down (probe fails) while pollLoop is running
    healthCheckResult = false;

    // Manually trigger health probe
    await (service as any).runHealthProbe();
    await settle(50);

    const status = service.getStatus();
    assert.equal(status.connectionState, 'unhealthy', 'Health probe should detect silent hang');
    assert.equal(status.connected, false);
    assert.ok(status.lastError?.includes('health probe'));
  });

  it('beginLogin() cleans up existing polling before starting QR flow', async () => {
    writeFakeCredentials(configDir);
    (service as any).getConfig = () => ({ enabled: true, credentialsPath: join(configDir, 'weixin-credentials.json') });

    // Start polling first
    await service.start();
    await settle(50);
    assert.equal(service.getStatus().connectionState, 'polling');

    const callsBeforeLogin = getUpdatesCallCount;

    // beginLogin should abort existing pollLoop
    // Note: beginLogin will try to fetch QR code which will also be intercepted
    // by our mock. We just verify that the old pollLoop stops.
    const loginStatus = await service.beginLogin();

    // Should be in connecting/waiting_scan state for QR flow
    assert.equal(loginStatus.connectionState, 'connecting');
    assert.equal(loginStatus.loginStatus, 'waiting_scan');

    // Old pollLoop should have stopped — no new getUpdates calls after a brief settle
    await settle(200);
    // The count should not have grown significantly (may have 1 in-flight call complete)
    assert.ok(
      getUpdatesCallCount <= callsBeforeLogin + 1,
      `Old pollLoop should stop after beginLogin. Calls: ${callsBeforeLogin} → ${getUpdatesCallCount}`,
    );
  });
});
