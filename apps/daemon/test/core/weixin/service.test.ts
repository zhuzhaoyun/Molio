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

  it('injects wiki query prompt when Weixin runs against the active vault cwd', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    const message = buildWeixinRunMessage(db, '介绍一下知识库地址', vaultPath, true);

    assert.match(message, /你的任务：使用 vault 的 wiki 和源文件来回答用户的问题。/);
    assert.match(message, /用户问题：介绍一下知识库地址/);
  });

  it('does not re-inject wiki query prompt after conversation history exists', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);

    const message = buildWeixinRunMessage(db, '继续', vaultPath, false);

    assert.equal(message, '继续');
  });
});
