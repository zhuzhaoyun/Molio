import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../../src/core/db.js';

/**
 * MOLIO_DATA_DIR —— daemon 数据目录环境钩子。
 *
 * 动机：E2E daemon 与用户真实 `~/.molio` 共库，测试建删 vault 直接读写真实
 * 数据；且真实重型 vault（上千条目目录）的同步 scanTree 会长时间阻塞事件循环，
 * 造成 E2E 散点式 fetch failed。playwright.config 据此给 E2E daemon 注入
 * 洁净数据目录。
 */
describe('openDatabase MOLIO_DATA_DIR', () => {
  let dir: string;
  const prevEnv = process.env.MOLIO_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-data-dir-'));
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (prevEnv === undefined) delete process.env.MOLIO_DATA_DIR;
    else process.env.MOLIO_DATA_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('无参调用时遵守 MOLIO_DATA_DIR（库文件建在指定目录）', () => {
    process.env.MOLIO_DATA_DIR = dir;
    const db = openDatabase();
    try {
      assert.ok(existsSync(join(dir, 'app.sqlite')));
      // 能正常建表查询
      db.prepare('SELECT count(*) AS n FROM vaults').get();
    } finally {
      closeDatabase();
    }
  });

  it('显式 dataDir 参数优先于环境变量', () => {
    process.env.MOLIO_DATA_DIR = dir;
    const explicit = mkdtempSync(join(tmpdir(), 'molio-data-dir-explicit-'));
    try {
      openDatabase(explicit);
      assert.ok(existsSync(join(explicit, 'app.sqlite')));
      assert.ok(!existsSync(join(dir, 'app.sqlite')));
    } finally {
      closeDatabase();
      rmSync(explicit, { recursive: true, force: true });
    }
  });
});
