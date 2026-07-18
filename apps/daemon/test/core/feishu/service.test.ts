import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, getConversationByExternalSession } from '../../../src/core/db.js';
import { FeishuService } from '../../../src/core/feishu/service.js';
import { FeishuApi, DEFAULT_BASE_URL } from '../../../src/core/feishu/client.js';
import { ConversationService } from '../../../src/core/conversations/service.js';
import type { FeishuRawEvent } from '../../../src/core/feishu/types.js';
import { loadConfig, saveConfig, type AppConfig } from '../../../src/core/config.js';
import type { RunManager } from '../../../src/core/RunManager.js';

/** Minimal mock of RunManager — only the methods FeishuService uses. */
function createMockRunManager(): RunManager {
  return {
    createRun: async () => 'mock-run-id',
    onEvent: () => () => {},
    cancelAll: () => {},
    canAcceptMessage: () => true,
  } as unknown as RunManager;
}

function makeTextEvent(openId: string, text: string, messageId: string): FeishuRawEvent {
  return {
    event_id: `evt-${messageId}`,
    sender: { sender_id: { open_id: openId }, sender_type: 'user' },
    message: {
      message_id: messageId,
      create_time: String(Date.now()),
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

describe('FeishuService', () => {
  let db: Database.Database;
  let tempDir: string;
  let service: FeishuService;
  let conversations: ConversationService;
  let originalUserprofile: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-feishu-test-'));
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
    service = new FeishuService(createMockRunManager(), conversations, db);
    originalUserprofile = process.env.USERPROFILE;
    originalHome = process.env.HOME;
    process.env.USERPROFILE = tempDir;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    service.stop();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('status & config', () => {
    it('starts in idle state with no app config', () => {
      const status = service.getStatus();
      assert.equal(status.connectionState, 'idle');
      assert.equal(status.connected, false);
      assert.equal(status.hasAppConfig, false);
      assert.equal(status.hasCredentials, false);
    });

    it('reports hasAppConfig=true when appId + appSecret are configured', () => {
      saveConfig({
        agents: {},
        feishu: { enabled: false, appId: 'cli_test', appSecret: 'secret_xyz' },
      } as AppConfig);
      const status = service.getStatus();
      assert.equal(status.hasAppConfig, true);
      assert.equal(status.enabled, false);
    });

    it('start() without enabled stays idle', async () => {
      const status = await service.start();
      assert.equal(status.connectionState, 'idle');
      assert.equal(status.connected, false);
    });

    it('start() without appId/appSecret surfaces a clear error and stays idle', async () => {
      saveConfig({ agents: {}, feishu: { enabled: true } } as AppConfig);
      const status = await service.start();
      assert.equal(status.connectionState, 'idle');
      assert.equal(status.connected, false);
      assert.match(status.lastError ?? '', /appId\/appSecret/);
    });

    it('stop() transitions to idle and clears active run', () => {
      const status = service.stop();
      assert.equal(status.connectionState, 'idle');
      assert.equal(status.connected, false);
      assert.equal(status.loginStatus, 'idle');
      assert.equal(status.activeRunId, null);
    });
  });

  describe('disconnect', () => {
    it('removes the credentials file and disables the channel', () => {
      const credsPath = join(tempDir, '.molio', 'feishu-credentials.json');
      mkdirSync(join(tempDir, '.molio'), { recursive: true });
      writeFileSync(
        credsPath,
        JSON.stringify({ tenantAccessToken: 'x', expiresAt: Date.now() + 60000 }),
        'utf8',
      );
      saveConfig({ agents: {}, feishu: { enabled: true, appId: 'a', appSecret: 'b' } } as AppConfig);
      assert.ok(existsSync(credsPath));

      service.disconnect();
      assert.ok(!existsSync(credsPath));
      // Reload config to verify enabled=false was persisted.
      assert.equal(loadConfig().feishu?.enabled, false);
    });
  });

  describe('handleRawMessage — /new command', () => {
    it('closes the external session and cancels the reusable run on /new', async () => {
      const openId = 'ou_test_user';
      // Seed an existing external conversation so closeExternalSession has something to close.
      conversations.getOrCreateExternalConversation({
        channelType: 'feishu',
        externalSessionId: openId,
        title: `飞书 ${openId.slice(-8)}`,
      });

      // Bypass the private visibility — handleRawMessage is the inbound WS path.
      await (service as unknown as { handleRawMessage: (e: FeishuRawEvent) => Promise<void> })
        .handleRawMessage(makeTextEvent(openId, '/new', 'msg-new'));

      // closeExternalSession flips a 'closed_at' flag — closed conversations are
      // filtered out of getConversationByExternalSession so the next inbound
      // message starts a fresh conversation. Asserting that the closed conv is
      // no longer reachable verifies /new ran the close path.
      const conv = getConversationByExternalSession(db, 'feishu', openId);
      assert.equal(conv, null, 'closed conversation should not be reachable via external session lookup');
    });

    it('ignores a duplicate message_id within the dedup window', async () => {
      const openId = 'ou_test_user_dup';
      const event = makeTextEvent(openId, 'hello', 'msg-dup');
      // First delivery: should not throw.
      await (service as unknown as { handleRawMessage: (e: FeishuRawEvent) => Promise<void> })
        .handleRawMessage(event);
      // Second delivery: should be deduped silently (no throw).
      await (service as unknown as { handleRawMessage: (e: FeishuRawEvent) => Promise<void> })
        .handleRawMessage(event);
    });
  });
});

describe('FeishuService token cache', () => {
  let db: Database.Database;
  let tempDir: string;
  let originalUserprofile: string | undefined;
  let originalHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-feishu-token-'));
    db = openDatabase(tempDir);
    originalUserprofile = process.env.USERPROFILE;
    originalHome = process.env.HOME;
    process.env.USERPROFILE = tempDir;
    process.env.HOME = tempDir;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    globalThis.fetch = originalFetch;
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists tenant_access_token to ~/.molio/feishu-credentials.json on refresh', async () => {
    let tokenCalls = 0;
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('tenant_access_token/internal')) {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: `tok-${tokenCalls}`, expire: 7200 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // No other endpoints should be hit in this test.
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    saveConfig({
      agents: {},
      defaultAgentId: 'claude',
      feishu: { enabled: true, appId: 'cli_x', appSecret: 'sec_x' },
    } as AppConfig);

    const conversations = new ConversationService(db);
    const service = new FeishuService(
      {
        createRun: async () => 'mock-run-id',
        onEvent: () => () => {},
        cancelAll: () => {},
        canAcceptMessage: () => true,
      } as unknown as RunManager,
      conversations,
      db,
    );

    try {
      // Inject the api directly — bypasses WSClient startup (which needs real
      // network) so we can isolate token-cache behavior.
      (service as unknown as { api: FeishuApi | null }).api = new FeishuApi(DEFAULT_BASE_URL, 'cli_x', 'sec_x');

      // Call ensureToken twice via the private accessor — second call should hit
      // the cache and not trigger another fetch.
      const before = tokenCalls;
      await (service as unknown as { ensureToken: () => Promise<string> }).ensureToken();
      const afterFirst = tokenCalls;
      await (service as unknown as { ensureToken: () => Promise<string> }).ensureToken();
      const afterSecond = tokenCalls;

      assert.equal(afterFirst - before, 1, 'first ensureToken should hit the token endpoint');
      assert.equal(afterSecond, afterFirst, 'second ensureToken should be served from cache');

      // Credentials file should now exist on disk with the token.
      const credsPath = join(tempDir, '.molio', 'feishu-credentials.json');
      assert.ok(existsSync(credsPath), 'credentials file should be written');
      const stored = JSON.parse(readFileSync(credsPath, 'utf8'));
      assert.equal(stored.tenantAccessToken, `tok-1`);
      assert.equal(typeof stored.expiresAt, 'number');
    } finally {
      service.stop();
    }
  });
});
