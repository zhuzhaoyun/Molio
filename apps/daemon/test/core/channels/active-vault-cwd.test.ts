/**
 * Channel run cwd must follow the UI-selected active vault.
 *
 * Regression context (2026-10 user report): 微信端入库永远进最初的库.
 * resolveRunCwd used to read only config.json's `defaultCwd`, which is a
 * lagging mirror written by a web-side effect — the daemon DB's `active_vault`
 * KV (synced on every vault switch via POST /active-vault) was ignored.
 * These tests pin the new priority:
 *   active vault (db, dir exists) > config.defaultCwd > channel cfg.defaultCwd
 * and the helper's defensive fallbacks (no db / no KV / stale row / dead dir).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  openDatabase,
  closeDatabase,
  createVault,
  setActiveVaultId,
} from '../../../src/core/db.js';
import { getActiveVaultCwd } from '../../../src/core/channels/active-vault-cwd.js';
import { WeixinService } from '../../../src/core/weixin/service.js';
import { FeishuService } from '../../../src/core/feishu/service.js';
import { ConversationService } from '../../../src/core/conversations/service.js';
import type { RunManager } from '../../../src/core/RunManager.js';

/** Minimal RunManager stand-in — resolveRunCwd never touches it. */
const stubRunManager = {} as unknown as RunManager;

describe('channel active-vault cwd resolution', () => {
  let tempDir: string;
  let vaultADir: string;
  let vaultBDir: string;
  let db: Database.Database;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-active-vault-cwd-'));
    vaultADir = join(tempDir, 'vault-a');
    vaultBDir = join(tempDir, 'vault-b');
    mkdirSync(vaultADir);
    mkdirSync(vaultBDir);

    // Redirect loadConfig() (~/.molio/config.json) into the temp dir so
    // `defaultCwd` is under test control, not the developer's real config.
    savedDataDir = process.env['MOLIO_DATA_DIR'];
    process.env['MOLIO_DATA_DIR'] = tempDir;
    writeFileSync(
      join(tempDir, 'config.json'),
      JSON.stringify({ agents: {}, defaultCwd: vaultADir }),
    );

    db = openDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase(db);
    if (savedDataDir === undefined) delete process.env['MOLIO_DATA_DIR'];
    else process.env['MOLIO_DATA_DIR'] = savedDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getActiveVaultCwd helper', () => {
    it('returns undefined without a db handle', () => {
      assert.equal(getActiveVaultCwd(undefined), undefined);
    });

    it('returns undefined when no active vault was ever synced', () => {
      assert.equal(getActiveVaultCwd(db), undefined);
    });

    it('returns the active vault path', () => {
      const vault = createVault(db, 'B', vaultBDir);
      setActiveVaultId(db, vault.id);
      assert.equal(getActiveVaultCwd(db), vaultBDir);
    });

    it('returns undefined for a stale pointer (vault row gone)', () => {
      setActiveVaultId(db, 'no-such-vault-id');
      assert.equal(getActiveVaultCwd(db), undefined);
    });

    it('returns undefined when the vault directory no longer exists', () => {
      const vault = createVault(db, 'B', vaultBDir);
      setActiveVaultId(db, vault.id);
      rmSync(vaultBDir, { recursive: true, force: true });
      assert.equal(getActiveVaultCwd(db), undefined);
    });
  });

  describe('WeixinService.resolveRunCwd priority', () => {
    function makeService(): WeixinService {
      return new WeixinService(stubRunManager, new ConversationService(db), db);
    }

    function resolveRunCwd(service: WeixinService, cfg: { defaultCwd?: string }): string | undefined {
      return (service as unknown as {
        resolveRunCwd: (cfg: { defaultCwd?: string }) => string | undefined;
      }).resolveRunCwd(cfg);
    }

    it('prefers the active vault over config defaultCwd and channel cfg', () => {
      const vaultB = createVault(db, 'B', vaultBDir);
      setActiveVaultId(db, vaultB.id);
      const service = makeService();
      // config.json defaultCwd = vaultADir; channel cfg = a third path.
      assert.equal(resolveRunCwd(service, { defaultCwd: join(tempDir, 'vault-c') }), vaultBDir);
    });

    it('falls back to config defaultCwd when no active vault is synced', () => {
      const service = makeService();
      assert.equal(resolveRunCwd(service, { defaultCwd: join(tempDir, 'vault-c') }), vaultADir);
    });

    it('falls back to config defaultCwd when the active vault dir is gone', () => {
      const vaultB = createVault(db, 'B', vaultBDir);
      setActiveVaultId(db, vaultB.id);
      rmSync(vaultBDir, { recursive: true, force: true });
      const service = makeService();
      assert.equal(resolveRunCwd(service, {}), vaultADir);
    });

    it('falls back to the channel cfg defaultCwd when config has none', () => {
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ agents: {} }));
      const service = makeService();
      const channelCwd = join(tempDir, 'vault-c');
      assert.equal(resolveRunCwd(service, { defaultCwd: channelCwd }), channelCwd);
    });
  });

  describe('FeishuService.resolveRunCwd priority', () => {
    // Bypass the constructor (token store / WS wiring are irrelevant here and
    // may schedule timers) — resolveRunCwd only reads this.db + config.
    function makeService(): FeishuService {
      const svc = Object.create(FeishuService.prototype) as FeishuService;
      (svc as unknown as { db: Database.Database }).db = db;
      return svc;
    }

    function resolveRunCwd(service: FeishuService, cfg: { defaultCwd?: string }): string | undefined {
      return (service as unknown as {
        resolveRunCwd: (cfg: { defaultCwd?: string }) => string | undefined;
      }).resolveRunCwd(cfg);
    }

    it('prefers the active vault over config defaultCwd', () => {
      const vaultB = createVault(db, 'B', vaultBDir);
      setActiveVaultId(db, vaultB.id);
      assert.equal(resolveRunCwd(makeService(), {}), vaultBDir);
    });

    it('falls back to config defaultCwd when no active vault is synced', () => {
      assert.equal(resolveRunCwd(makeService(), {}), vaultADir);
    });
  });
});
