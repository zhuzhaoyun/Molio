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
import type { UploadedFileInfo } from '../../../src/core/weixin/types.js';

/** RunManager mock that captures the event handler so the test can emit events. */
function createEmittingRunManager(): { rm: RunManager; emit: (e: AgentEvent) => void } {
  let handler: ((e: AgentEvent) => void) | null = null;
  const rm = {
    createRun: async () => 'run-1',
    // These tests exercise the single-message reply path, not multi-turn
    // reuse, so canAcceptMessage reports false (no reuse → fresh spawn).
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

describe('WeixinService media reply path', () => {
  let db: Database.Database;
  let tempDir: string;
  let service: WeixinService;
  let conversations: ConversationService;
  let emit: (e: AgentEvent) => void;
  let originalSendText: typeof WeixinApi.prototype.sendText;
  let originalUploadMedia: typeof WeixinApi.prototype.uploadMedia;
  let originalSendImage: typeof WeixinApi.prototype.sendImageMessage;
  let originalSendFile: typeof WeixinApi.prototype.sendFileMessage;

  const sentTexts: string[] = [];
  const uploadedFiles: Array<{ filePath: string; toUserId: string; mediaType: number }> = [];
  const sentImages: Array<{ toUserId: string; uploaded: UploadedFileInfo; contextToken: string }> = [];
  const sentFiles: Array<{ toUserId: string; fileName: string; uploaded: UploadedFileInfo; contextToken: string }> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-media-reply-'));
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
    const { rm, emit: emitFn } = createEmittingRunManager();
    emit = emitFn;
    service = new WeixinService(rm, conversations, db);

    // Point getConfig at our temp config + a default agent + cwd.
    (service as unknown as { getConfig: () => unknown }).getConfig = () => ({
      enabled: true,
      defaultAgentId: 'agent-1',
      defaultCwd: tempDir,
    });

    // Attach an API instance (no polling) and monkey-patch its media methods.
    (service as unknown as { api: WeixinApi }).api = new WeixinApi('https://ilinkai.weixin.qq.com', 'tok');

    originalSendText = WeixinApi.prototype.sendText;
    originalUploadMedia = WeixinApi.prototype.uploadMedia;
    originalSendImage = WeixinApi.prototype.sendImageMessage;
    originalSendFile = WeixinApi.prototype.sendFileMessage;

    sentTexts.length = 0;
    uploadedFiles.length = 0;
    sentImages.length = 0;
    sentFiles.length = 0;

    WeixinApi.prototype.sendText = async function (this: WeixinApi, toUserId: string, text: string) {
      sentTexts.push(text);
      return { ret: 0, errcode: 0 };
    };
    WeixinApi.prototype.uploadMedia = async function (
      this: WeixinApi,
      filePath: string,
      toUserId: string,
      mediaType: number,
    ) {
      uploadedFiles.push({ filePath, toUserId, mediaType });
      return {
        filekey: 'fk',
        downloadEncryptedQueryParam: 'dl-param',
        aeskey: '40cfdb7dad8f87582960666f58f03048',
        fileSize: 10,
        fileSizeCiphertext: 16,
      } as UploadedFileInfo;
    };
    WeixinApi.prototype.sendImageMessage = async function (
      this: WeixinApi,
      toUserId: string,
      uploaded: UploadedFileInfo,
      contextToken: string,
    ) {
      sentImages.push({ toUserId, uploaded, contextToken });
      return { ret: 0, errcode: 0 };
    };
    WeixinApi.prototype.sendFileMessage = async function (
      this: WeixinApi,
      toUserId: string,
      fileName: string,
      uploaded: UploadedFileInfo,
      contextToken: string,
    ) {
      sentFiles.push({ toUserId, fileName, uploaded, contextToken });
      return { ret: 0, errcode: 0 };
    };
  });

  afterEach(() => {
    WeixinApi.prototype.sendText = originalSendText;
    WeixinApi.prototype.uploadMedia = originalUploadMedia;
    WeixinApi.prototype.sendImageMessage = originalSendImage;
    WeixinApi.prototype.sendFileMessage = originalSendFile;
    service.stop();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Drive a user text message through the service as if it arrived via polling. */
  async function deliverUserMessage(text: string, fromUserId = 'user-1@im.wechat'): Promise<void> {
    const raw = {
      message_id: 'msg-1',
      from_user_id: fromUserId,
      to_user_id: 'bot-1@im.bot',
      context_token: 'ctx-token-1',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text } }],
    };
    // handleRawMessage is private; invoke directly to avoid polling flakiness.
    await (service as unknown as { handleRawMessage: (r: typeof raw) => Promise<void> }).handleRawMessage(raw);
  }

  it('delivers an image the AI wrote via Write tool as an image message', async () => {
    const imgPath = join(tempDir, 'chart.png');
    writeFileSync(imgPath, 'png-bytes');

    await deliverUserMessage('生成一张图');

    // Simulate the agent stream: it wrote an image, then ended its turn.
    emit({ type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: imgPath } });
    emit({ type: 'text_delta', delta: '已生成图片' });
    emit({ type: 'turn_end', stopReason: 'end_turn' });

    // Let the async finish() chain settle.
    await new Promise((r) => setTimeout(r, 50));

    // Text reply was sent.
    assert.ok(sentTexts.some((t) => t.includes('已生成图片')), `expected reply text, got ${JSON.stringify(sentTexts)}`);
    // Image was uploaded + delivered with the stored context token.
    assert.equal(uploadedFiles.length, 1);
    assert.equal(uploadedFiles[0]!.filePath, imgPath);
    assert.equal(uploadedFiles[0]!.mediaType, 1); // IMAGE
    assert.equal(sentImages.length, 1);
    assert.equal(sentImages[0]!.toUserId, 'user-1@im.wechat');
    assert.equal(sentImages[0]!.contextToken, 'ctx-token-1');
  });

  it('delivers a document (pdf) the AI wrote as a file attachment', async () => {
    const pdfPath = join(tempDir, 'summary.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 body');

    await deliverUserMessage('总结成 pdf');

    emit({ type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: pdfPath } });
    emit({ type: 'turn_end', stopReason: 'end_turn' });

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(uploadedFiles.length, 1);
    assert.equal(uploadedFiles[0]!.mediaType, 3); // FILE
    assert.equal(sentFiles.length, 1);
    assert.equal(sentFiles[0]!.fileName, 'summary.pdf');
    assert.equal(sentFiles[0]!.contextToken, 'ctx-token-1');
  });

  it('does not send source files the AI wrote (not on deliverable allowlist)', async () => {
    const tsPath = join(tempDir, 'module.ts');
    writeFileSync(tsPath, 'export {}');

    await deliverUserMessage('重构模块');

    emit({ type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: tsPath } });
    emit({ type: 'turn_end', stopReason: 'end_turn' });

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(uploadedFiles.length, 0);
    assert.equal(sentImages.length, 0);
    assert.equal(sentFiles.length, 0);
  });

  it('does not send files produced by Edit (only Write-like tools)', async () => {
    const imgPath = join(tempDir, 'editted.png');
    writeFileSync(imgPath, 'x');

    await deliverUserMessage('改下图');

    emit({ type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: imgPath } });
    emit({ type: 'turn_end', stopReason: 'end_turn' });

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(uploadedFiles.length, 0);
  });

  it('delivers a file the AI references via <attach/> marker and strips the path', async () => {
    // Simulate a file in a nested subdirectory (e.g. wiki clip, generated report)
    // without hardcoding any business-specific path structure.
    const subDir = mkdtempSync(join(tempDir, 'nested-'));
    const pdfPath = join(subDir, 'Goals.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 body');

    await deliverUserMessage('把这个文件发给我');

    // The AI emits an <attach/> marker. No Write tool_use.
    emit({
      type: 'text_delta',
      delta: `已附上文件。<attach path="${pdfPath}"/>`,
    });
    emit({ type: 'turn_end', stopReason: 'end_turn' });

    await new Promise((r) => setTimeout(r, 50));

    // Real file uploaded + delivered as attachment.
    assert.equal(uploadedFiles.length, 1);
    assert.equal(uploadedFiles[0]!.filePath, pdfPath);
    assert.equal(uploadedFiles[0]!.mediaType, 3); // FILE
    assert.equal(sentFiles.length, 1);
    assert.equal(sentFiles[0]!.fileName, 'Goals.pdf');
    // The path / marker never reaches WeChat as text.
    assert.ok(!sentTexts.some((t) => t.includes(pdfPath)), 'path must not leak to WeChat text');
    assert.ok(sentTexts.some((t) => t.includes('已附上文件')));
  });
});
