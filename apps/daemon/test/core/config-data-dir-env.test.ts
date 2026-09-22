import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, type AppConfig } from '../../src/core/config.js';

/**
 * MOLIO_DATA_DIR 对 config.json 的作用（与 db.ts 同名钩子配套）：
 * E2E 洁净数据目录下，saveConfig/loadConfig 落到指定目录，不碰用户真实
 * ~/.molio/config.json。claudeDir（~/.claude）刻意不跟随——读真实
 * CC Switch settings.json 是 resolveClaudeModels 的功能语义。
 */
describe('config MOLIO_DATA_DIR', () => {
  let dir: string;
  const prevEnv = process.env.MOLIO_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-config-dir-'));
    closePrev();
    process.env.MOLIO_DATA_DIR = dir;
  });

  afterEach(() => {
    closePrev();
    if (prevEnv === undefined) delete process.env.MOLIO_DATA_DIR;
    else process.env.MOLIO_DATA_DIR = prevEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  function closePrev() { /* loadConfig 无需显式关闭；占位对称 */ }

  it('saveConfig 落到 MOLIO_DATA_DIR 下的 config.json', () => {
    const cfg: AppConfig = { agents: {}, defaultAgentId: 'claude' };
    saveConfig(cfg);
    assert.ok(existsSync(join(dir, 'config.json')));
    const loaded = loadConfig();
    assert.equal(loaded.defaultAgentId, 'claude');
  });
});
