import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AgentEvent } from '@molio/contracts';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { WeixinService } from '../../../src/core/weixin/service.js';
import { ConversationService } from '../../../src/core/conversations/service.js';
import { WeixinApi } from '../../../src/core/weixin/client.js';
import type { RunManager } from '../../../src/core/RunManager.js';

/** Mirrors SESSION_EXPIRED_CODE in src/core/weixin/service.ts (not exported). */
const SESSION_EXPIRED_CODE = -14;

/** RunManager mock that captures the event handler so the test can emit events. */
function createEmittingRunManager(): { rm: RunManager; emit: (e: AgentEvent) => void } {
  let handler: ((e: AgentEvent) => void) | null = null;
  const rm = {
    createRun: async () => 'run-1',
    canAcceptMessage: () => false,
    sendMessage: () => {},
    flushPendingReply: () => {},
    cancelRun: () => {},
    onEvent: (_runId: string, cb: (e: AgentEvent) => void) => {
      handler = cb;
      return () => { handler = null; };
    },
    cancelAll: () => {},
  } as unknown as RunManager;
  return { rm, emit: (e: AgentEvent) => handler?.(e) };
}

/**
 * Regression tests for the 2026-08-23 review finding on the attachment-
 * visibility fix: when a WeChat context token EXPIRES mid-turn, the failed
 * attachment used to drop the token and throw — and the dispatcher's
 * "attachment could not be sent" notice then went through sendText, which
 * silently no-oped without a token. The user saw "已附上" text, no file, no
 * notice: the very silent failure the fix set out to eliminate.
 *
 * Contract pinned here: undeliverable text is BUFFERED, and flushed as soon
 * as the user's next inbound message brings a fresh context token.
 */
describe('WeChat session expiry must not silently lose failure notices', () => {
  let db: Database.Database;
  let tempDir: string;
  let service: WeixinService;
  let emit: (e: AgentEvent) => void;
  let originalSendText: typeof WeixinApi.prototype.sendText;
  let originalUploadMedia: typeof WeixinApi.prototype.uploadMedia;
  let originalSendFile: typeof WeixinApi.prototype.sendFileMessage;
  let msgSeq: number;

  const sentTexts: string[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-expiry-notice-'));
    db = openDatabase(tempDir);
    const conversations = new ConversationService(db);
    const { rm, emit: emitFn } = createEmittingRunManager();
    emit = emitFn;
    service = new WeixinService(rm, conversations, db);
    msgSeq = 0;

    // credentialsPath into tempDir: persistContextTokens must never touch the
    // real ~/.molio/weixin-credentials.json (would clobber the user's saved
    // tokens and race other test files on the .tmp rename).
    (service as unknown as { getConfig: () => unknown }).getConfig = () => ({
      enabled: true,
      defaultAgentId: 'agent-1',
      defaultCwd: tempDir,
      credentialsPath: join(tempDir, 'weixin-credentials.json'),
    });

    (service as unknown as { api: WeixinApi }).api = new WeixinApi('https://ilinkai.weixin.qq.com', 'tok');

    originalSendText = WeixinApi.prototype.sendText;
    originalUploadMedia = WeixinApi.prototype.uploadMedia;
    originalSendFile = WeixinApi.prototype.sendFileMessage;

    sentTexts.length = 0;

    WeixinApi.prototype.sendText = async function (this: WeixinApi, _toUserId: string, text: string) {
      sentTexts.push(text);
      return { ret: 0, errcode: 0 };
    };
    WeixinApi.prototype.uploadMedia = async function () {
      return {
        filekey: 'fk',
        downloadEncryptedQueryParam: 'dl-param',
        aeskey: '40cfdb7dad8f87582960666f58f03048',
        fileSize: 10,
        fileSizeCiphertext: 16,
      };
    };
    WeixinApi.prototype.sendFileMessage = async function () {
      return { ret: 0, errcode: 0 };
    };
  });

  afterEach(() => {
    WeixinApi.prototype.sendText = originalSendText;
    WeixinApi.prototype.uploadMedia = originalUploadMedia;
    WeixinApi.prototype.sendFileMessage = originalSendFile;
    service.stop();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Drive a user text message through the service as if it arrived via polling. */
  async function deliverUserMessage(
    text: string,
    contextToken: string,
    fromUserId = 'user-1@im.wechat',
  ): Promise<void> {
    msgSeq += 1;
    const raw = {
      message_id: `msg-${msgSeq}`,
      from_user_id: fromUserId,
      to_user_id: 'bot-1@im.bot',
      context_token: contextToken,
      message_type: 1,
      item_list: [{ type: 1, text_item: { text } }],
    };
    // handleRawMessage is private; invoke directly to avoid polling flakiness.
    await (service as unknown as { handleRawMessage: (r: typeof raw) => Promise<void> }).handleRawMessage(raw);
  }

  it('expiry during attachment delivery: notice is buffered, flushed on next inbound', async () => {
    const pdfPath = join(tempDir, 'report.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 body');

    await deliverUserMessage('把文件发给我', 'ctx-1');

    // The file send comes back session-expired: the token gets dropped and
    // sendMediaFile throws — exactly the edge case under test.
    WeixinApi.prototype.sendFileMessage = async function () {
      return { ret: SESSION_EXPIRED_CODE, errcode: 0 };
    };

    emit({ type: 'text_delta', delta: `已附上。<attach path="${pdfPath}"/>` });
    emit({ type: 'turn_end', stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 50));

    // The reply text went out BEFORE the send failed (token still alive)...
    assert.ok(sentTexts.some((t) => t.includes('已附上。')));
    // ...but the failure notice could not ride the expired token. It must be
    // buffered, NOT dropped — so it is not sent yet at this point.
    assert.ok(!sentTexts.some((t) => t.includes('未能发送')));

    // The user's next message brings a fresh context token → the buffered
    // notice flushes ahead of the new turn's replies.
    await deliverUserMessage('在吗', 'ctx-2');
    await new Promise((r) => setTimeout(r, 50));

    const notice = sentTexts.find((t) => t.includes('未能发送'));
    assert.ok(notice, 'failure notice must be delivered once credentials return');
    assert.ok(notice!.includes('report.pdf'));
    assert.ok(notice!.includes('微信会话已过期'));
    // The flush ran BEFORE the new turn started: the notice precedes the
    // second turn's "正在处理" (the first turn sent its own earlier).
    const processingIdx = sentTexts
      .map((t, i) => (t.includes('正在处理') ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(sentTexts.indexOf(notice!) < processingIdx.at(-1)!);
  });

  it('multi-attachment turn after expiry: one root cause, not a mix of expired/missing', async () => {
    const pdfA = join(tempDir, 'a.pdf');
    const pdfB = join(tempDir, 'b.pdf');
    writeFileSync(pdfA, '%PDF-1.4 A');
    writeFileSync(pdfB, '%PDF-1.4 B');

    await deliverUserMessage('两个文件都发我', 'ctx-1');

    // First item hits expiry (drops the token); the second then finds no
    // token and must report the SAME root cause, not "凭证缺失".
    WeixinApi.prototype.sendFileMessage = async function () {
      return { ret: SESSION_EXPIRED_CODE, errcode: 0 };
    };

    emit({ type: 'text_delta', delta: `都附上了。<attach path="${pdfA}"/><attach path="${pdfB}"/>` });
    emit({ type: 'turn_end', stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 50));

    // Notice couldn't be sent (no token) — next inbound flushes it.
    await deliverUserMessage('收到了吗', 'ctx-2');
    await new Promise((r) => setTimeout(r, 50));

    const notice = sentTexts.find((t) => t.includes('未能发送'));
    assert.ok(notice, 'failure notice must be delivered once credentials return');
    assert.ok(notice!.includes('a.pdf'));
    assert.ok(notice!.includes('b.pdf'));
    assert.ok(!notice!.includes('凭证缺失'), 'later items must not report the confusing missing-credential error');
    assert.equal(notice!.split('微信会话已过期').length - 1, 2, 'both items name the same root cause');
  });

  it('sendText without credentials buffers (capped) instead of dropping', async () => {
    // No context token at all for this user — every sendText used to silently
    // return. Now it buffers, capped at the newest 8 (oldest dropped).
    for (let i = 1; i <= 9; i += 1) {
      await service.sendText('user-2@im.wechat', `notice-${i}`);
    }
    assert.equal(sentTexts.length, 0, 'nothing can be sent without credentials');

    await deliverUserMessage('你好', 'ctx-9', 'user-2@im.wechat');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(!sentTexts.includes('notice-1'), 'oldest buffered notice is dropped at the cap');
    for (let i = 2; i <= 9; i += 1) {
      assert.ok(sentTexts.includes(`notice-${i}`), `notice-${i} must be flushed`);
    }
  });

  it('buffers while the API is down and flushes after reconnect', async () => {
    // Whole bot session gone (stop/expired sets api = null): texts must still
    // buffer, and flush once the api is back and an inbound brings a token.
    (service as unknown as { api: WeixinApi | null }).api = null;
    await service.sendText('user-3@im.wechat', '你的附件未能发送');
    assert.equal(sentTexts.length, 0);

    (service as unknown as { api: WeixinApi | null }).api = new WeixinApi('https://ilinkai.weixin.qq.com', 'tok');
    await deliverUserMessage('hi', 'ctx-3', 'user-3@im.wechat');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(sentTexts.includes('你的附件未能发送'));
  });
});
