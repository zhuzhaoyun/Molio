import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../../src/core/db.js';
import { buildWeixinRunMessage } from '../../../src/core/weixin/service.js';
import { WIKI_WEIXIN_PROMPT } from '../../../src/core/wiki-prompts.js';

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

  it('passes wiki frame as system prompt (not in user message) on first vault turn', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    const result = buildWeixinRunMessage(db, '介绍一下知识库地址', vaultPath, true);

    // The user message is the clean prompt — the wiki frame must NOT be
    // prepended to it (that role-locks the agent and suppresses native
    // retrieval; verified by the Run A/B/C probes).
    assert.equal(result.message, '介绍一下知识库地址');
    assert.doesNotMatch(result.message, /你是一个本地知识库的微信入口助手。/);
    // The wiki frame travels as the agent's system prompt instead.
    assert.equal(result.appendSystemPrompt, WIKI_WEIXIN_PROMPT);
    assert.match(result.appendSystemPrompt!, /自动收件，确认后知识化入库/);
  });

  it('does NOT pass wiki frame on follow-up turns (reused session)', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    // isFirstTurn=false → follow-up to a reused multi-turn session that
    // already carries the frame from turn 1's system prompt. Re-passing it
    // is unnecessary (sendMessage reuses the live process).
    const result = buildWeixinRunMessage(db, '继续', vaultPath, false);

    assert.equal(result.appendSystemPrompt, undefined);
    assert.equal(result.message, '继续');
  });

  it('keeps file-handling rules inside the wiki system prompt', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    const result = buildWeixinRunMessage(db, '收到文件', vaultPath, true);

    // The user message is clean; all intake rules live in the system prompt.
    assert.equal(result.message, '收到文件');
    const sys = result.appendSystemPrompt!;
    // Downloaded entity files are the staging material themselves — no extra
    // .md placeholder should be created.
    assert.match(sys, /不要再额外新建/);
    assert.match(sys, /暂存文件/);
    // URL/web-share fallback still creates a .md.
    assert.match(sys, /raw\/wechat\/YYYY-MM-DD\/HHmm-简短标题\.md/);
    // mp.weixin.qq.com links must use the wechat-article-extractor skill,
    // not WebFetch (blocked by enterprise security policy).
    assert.match(sys, /wechat-article-extractor/);
    assert.match(sys, /禁止用 WebFetch/);
  });
});
