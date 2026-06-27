import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../../src/core/db.js';
import { buildWeixinRunMessage } from '../../../src/core/weixin/service.js';
import { WEIXIN_SYS_PROMPT_FILE } from '../../../src/core/wiki-prompts.js';

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

  it('passes wiki frame as system-prompt file (not in user message) on first vault turn', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    const result = buildWeixinRunMessage(db, '介绍一下知识库地址', vaultPath, true);

    // The user message is the clean prompt — the wiki frame must NOT be
    // prepended to it (that role-locks the agent and suppresses native
    // retrieval; verified by the Run A/B/C probes).
    assert.equal(result.message, '介绍一下知识库地址');
    assert.doesNotMatch(result.message, /你是一个本地知识库的微信入口助手。/);
    // The wiki frame travels as a system-prompt FILE path instead (the file
    // itself is materialized by ensureWikiSysPromptFiles at daemon startup).
    assert.equal(result.appendSystemPromptFile, WEIXIN_SYS_PROMPT_FILE);
  });

  it('does NOT pass wiki frame on follow-up turns (reused session)', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    // isFirstTurn=false → follow-up to a reused multi-turn session that
    // already carries the frame from turn 1's system prompt. Re-passing it
    // is unnecessary (sendMessage reuses the live process).
    const result = buildWeixinRunMessage(db, '继续', vaultPath, false);

    assert.equal(result.appendSystemPromptFile, undefined);
    assert.equal(result.message, '继续');
  });

  it('does not pass wiki frame when cwd is not a vault', () => {
    const result = buildWeixinRunMessage(db, 'hi', '/not/a/vault', true);
    assert.equal(result.appendSystemPromptFile, undefined);
    assert.equal(result.message, 'hi');
  });
});
