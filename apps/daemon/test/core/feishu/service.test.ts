import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, getConversationByExternalSession } from '../../../src/core/db.js';
import { FeishuService } from '../../../src/core/feishu/service.js';
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

  afterEach(async () => {
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await service.stop();
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

    it('stop() transitions to idle and clears active run', async () => {
      const status = await service.stop();
      assert.equal(status.connectionState, 'idle');
      assert.equal(status.connected, false);
      assert.equal(status.loginStatus, 'idle');
      assert.equal(status.activeRunId, null);
    });
  });

  describe('disconnect', () => {
    it('removes the credentials file and disables the channel', async () => {
      const credsPath = join(tempDir, '.molio', 'feishu-credentials.json');
      mkdirSync(join(tempDir, '.molio'), { recursive: true });
      writeFileSync(
        credsPath,
        JSON.stringify({ tenantAccessToken: 'x', expiresAt: Date.now() + 60000 }),
        'utf8',
      );
      saveConfig({ agents: {}, feishu: { enabled: true, appId: 'a', appSecret: 'b' } } as AppConfig);
      assert.ok(existsSync(credsPath));

      await service.disconnect();
      assert.ok(!existsSync(credsPath));
      // Reload config to verify enabled=false was persisted.
      assert.equal(loadConfig().feishu?.enabled, false);
    });
  });

  describe('start(force) — explicit user action', () => {
    // An unreachable baseUrl makes the token fetch fail fast (ECONNREFUSED) so
    // these tests exercise the connect path without real network access.
    const UNREACHABLE = 'http://127.0.0.1:1';

    it('bug: 启动连接 after disconnect re-enables the channel (force) but auto-start stays off', async () => {
      saveConfig({
        agents: {},
        feishu: { enabled: true, appId: 'a', appSecret: 'b', baseUrl: UNREACHABLE },
      } as AppConfig);

      await service.disconnect();
      assert.equal(loadConfig().feishu?.enabled, false, 'disconnect should disable the channel');

      // Boot auto-start (no force) must NOT re-enable a disabled channel.
      const autoStatus = await service.start();
      assert.equal(loadConfig().feishu?.enabled, false, 'auto-start must leave a disabled channel off');
      assert.equal(autoStatus.connectionState, 'idle');

      // Explicit "启动连接" (force) re-enables and attempts to connect — it gets
      // past the disabled guard and reaches the token step (error here only
      // because the baseUrl is unreachable, NOT because it stayed idle/disabled).
      const forcedStatus = await service.start(true);
      assert.equal(loadConfig().feishu?.enabled, true, 'force start should re-enable the channel');
      assert.notEqual(forcedStatus.connectionState, 'idle', 'force start should attempt a connection');
    });

    it('bug: 重新连接 while connected tears down the live WS client (force), auto-start no-ops', async () => {
      saveConfig({
        agents: {},
        feishu: { enabled: true, appId: 'a', appSecret: 'b', baseUrl: UNREACHABLE },
      } as AppConfig);

      const s = service as unknown as {
        connectionState: string;
        status: { connected: boolean };
        wsClient: { stop: () => Promise<void> } | null;
      };

      // Simulate an already-connected state with a live WS client.
      let stoppedByAuto = false;
      s.connectionState = 'connected';
      s.status.connected = true;
      s.wsClient = { stop: async () => { stoppedByAuto = true; } };

      // Auto-start (no force) must leave the healthy connection untouched.
      await service.start();
      assert.equal(stoppedByAuto, false, 'auto-start must not tear down a healthy connection');
      assert.ok(s.wsClient, 'auto-start must keep the existing wsClient');

      // Explicit "重新连接" (force) must tear down the live client to reconnect.
      let stoppedByForce = false;
      s.connectionState = 'connected';
      s.status.connected = true;
      s.wsClient = { stop: async () => { stoppedByForce = true; } };
      await service.start(true);
      assert.equal(stoppedByForce, true, 'force start must tear down the live WS client to reconnect');
      assert.equal(s.wsClient, null, 'force start should drop the old wsClient before re-establishing');
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

  describe('sendText — interactive card first, plain-text fallback', () => {
    interface FakeApiRecorder {
      cardChunks: string[];
      textChunks: string[];
    }

    /**
     * Inject a fake api + tokenStore into the service's private fields (same
     * cast pattern as the start(force) tests above). `failCard` / `failText`
     * make the respective send path throw to exercise the fallback chain.
     */
    function injectFakeApi(
      svc: FeishuService,
      opts: { failCard?: boolean; failText?: boolean } = {},
    ): FakeApiRecorder {
      const rec: FakeApiRecorder = { cardChunks: [], textChunks: [] };
      const s = svc as unknown as {
        api: unknown;
        tokenStore: {
          getToken: () => Promise<string>;
          startRefresh: () => void;
          stopRefresh: () => void;
          invalidate: () => void;
        };
      };
      s.api = {
        sendCard: async (
          _tok: string,
          _openId: string,
          card: { body: { elements: [{ content: string }] } },
        ) => {
          if (opts.failCard) throw new Error('card rejected');
          rec.cardChunks.push(card.body.elements[0].content);
          return 'om_card';
        },
        sendText: async (_tok: string, _openId: string, text: string) => {
          if (opts.failText) throw new Error('text rejected');
          rec.textChunks.push(text);
          return 'om_text';
        },
      };
      // stop() in the outer afterEach calls tokenStore.stopRefresh() +
      // invalidate() — the fake must provide the full surface or teardown throws.
      s.tokenStore = {
        getToken: async () => 'tok',
        startRefresh: () => {},
        stopRefresh: () => {},
        invalidate: () => {},
      };
      return rec;
    }

    it('sends short markdown text as one card, no plain-text call', async () => {
      const rec = injectFakeApi(service);
      await service.sendText('ou_user', '# 标题\n**正文**');
      assert.deepEqual(rec.cardChunks, ['# 标题\n**正文**']);
      assert.equal(rec.textChunks.length, 0);
      assert.equal(service.getStatus().lastError, null);
    });

    it('falls back to plain text when card sending fails', async () => {
      const rec = injectFakeApi(service, { failCard: true });
      await service.sendText('ou_user', 'hello');
      assert.equal(rec.cardChunks.length, 0, 'failed card is not recorded');
      assert.deepEqual(rec.textChunks, ['hello'], 'same chunk must go out as plain text');
      assert.equal(service.getStatus().lastError, null, 'successful fallback is not an error');
    });

    it('records lastError without throwing when both card and text fail', async () => {
      injectFakeApi(service, { failCard: true, failText: true });
      await service.sendText('ou_user', 'hello'); // must not throw
      assert.match(service.getStatus().lastError ?? '', /发送消息失败/);
    });

    it('chunks long text into multiple cards (>3000 chars → 2 cards)', async () => {
      const rec = injectFakeApi(service);
      const long = 'a'.repeat(5000); // no paragraph/line breaks → hard cut at 3000
      await service.sendText('ou_user', long);
      assert.equal(rec.cardChunks.length, 2);
      assert.equal(rec.cardChunks[0]?.length, 3000);
      assert.equal(rec.cardChunks[1]?.length, 2000);
      assert.equal(rec.textChunks.length, 0);
    });
  });
});
