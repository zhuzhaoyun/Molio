import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../../src/core/db.js';
import { buildWeixinRunMessage } from '../../../src/core/weixin/service.js';

describe('WeixinService run context', () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-test-'));
    db = openDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('injects wiki context when Weixin runs against the active vault cwd', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    const message = buildWeixinRunMessage(db, '介绍一下知识库地址', vaultPath, true);

    assert.match(message, /你是一个本地知识库的微信入口助手。/);
    assert.match(message, /自动收件，确认后知识化入库/);
    assert.match(message, /用户消息：介绍一下知识库地址/);
  });

  it('does NOT re-inject wiki intake frame on follow-up turns (reused session)', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    // isFirstTurn=false → the message is a follow-up to a reused multi-turn
    // session that already carries the wiki frame from turn 1. Re-injecting
    // would pollute context and burn tokens, so only the raw prompt is sent.
    const message = buildWeixinRunMessage(db, '继续', vaultPath, false);

    assert.doesNotMatch(message, /你是一个本地知识库的微信入口助手。/);
    assert.equal(message, '继续');
  });

  it('tells the model to use downloaded files as-is, not create extra .md', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    const message = buildWeixinRunMessage(db, '收到文件', vaultPath, true);

    // The prompt must instruct the model that downloaded entity files are the
    // staging material themselves — no extra .md placeholder should be created.
    assert.match(message, /不要再额外新建/);
    assert.match(message, /暂存文件/);
    // And it must still cover URL/web-share fallback that does create a .md.
    assert.match(message, /raw\/wechat\/YYYY-MM-DD\/HHmm-简短标题\.md/);
    // mp.weixin.qq.com links must use the wechat-article-extractor skill,
    // not WebFetch (which is blocked by enterprise security policy).
    assert.match(message, /wechat-article-extractor/);
    assert.match(message, /禁止用 WebFetch/);
  });
});
