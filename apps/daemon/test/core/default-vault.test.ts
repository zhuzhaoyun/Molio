import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  openDatabase,
  closeDatabase,
  listVaults,
  createVault,
  getActiveVaultId,
  setActiveVaultId,
} from '../../src/core/db.js';
import { maybeCreateDefaultVault } from '../../src/core/default-vault.js';

/**
 * Default-vault auto-provisioning is what makes Docker/NAS one-click deploy
 * land inside a vault instead of an empty welcome screen. These tests pin the
 * safety invariants:
 *   - never touches an install that already has vaults,
 *   - never fabricates a folder unless the conventional mount already exists
 *     (so we don't write into the container's ephemeral layer),
 *   - explicit path / MOLIO_DEFAULT_VAULT_PATH override takes precedence.
 */
describe('maybeCreateDefaultVault', () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;
  let watched: Array<[string, string]>;
  const watcher = {
    watch(vaultId: string, vaultPath: string) {
      watched.push([vaultId, vaultPath]);
    },
  };
  const ENV_KEY = 'MOLIO_DEFAULT_VAULT_PATH';
  let savedEnv: string | undefined;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'molio-defvault-'));
    db = openDatabase(dataDir);
  });

  after(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    watched = [];
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    // Reset the vault table between cases so each starts from a clean install.
    for (const v of listVaults(db)) {
      db.prepare('DELETE FROM vaults WHERE id = ?').run(v.id);
    }
    setActiveVaultId(db, null);
  });

  it('creates + selects the default vault when the conventional mount exists', () => {
    const mount = mkdtempSync(join(tmpdir(), 'molio-mount-'));
    try {
      const vault = maybeCreateDefaultVault(db, watcher, { conventionPath: mount });
      assert.ok(vault, 'expected a vault to be created');
      assert.equal(vault.path, mount);
      assert.equal(listVaults(db).length, 1);
      assert.equal(getActiveVaultId(db), vault.id, 'default vault should be set active');
      assert.deepEqual(watched, [[vault.id, mount]], 'watcher should watch the new vault');
    } finally {
      rmSync(mount, { recursive: true, force: true });
    }
  });

  it('returns null and creates nothing when no mount exists and no override is set', () => {
    const missing = join(tmpdir(), `molio-nope-${Date.now()}-${Math.random()}`);
    const vault = maybeCreateDefaultVault(db, watcher, { conventionPath: missing });
    assert.equal(vault, null);
    assert.equal(listVaults(db).length, 0);
    assert.equal(getActiveVaultId(db), null);
    assert.deepEqual(watched, []);
  });

  it('does not use the conventional path when it is a file, not a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'molio-filemount-'));
    const asFile = join(dir, 'vaults');
    writeFileSync(asFile, 'not a directory');
    try {
      const vault = maybeCreateDefaultVault(db, watcher, { conventionPath: asFile });
      assert.equal(vault, null, 'a file at the convention path must not be treated as a mount');
      assert.equal(listVaults(db).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op once any vault already exists (never touches existing installs)', () => {
    const mount = mkdtempSync(join(tmpdir(), 'molio-existing-'));
    try {
      const preexisting = createVault(db, 'user-vault', mount);
      const created = maybeCreateDefaultVault(db, watcher, { conventionPath: mount });
      assert.equal(created, null);
      const vaults = listVaults(db);
      assert.equal(vaults.length, 1);
      assert.equal(vaults[0]?.id, preexisting.id);
      assert.deepEqual(watched, []);
    } finally {
      rmSync(mount, { recursive: true, force: true });
    }
  });

  it('honors an explicit path (created even if missing) over the convention path', () => {
    const base = mkdtempSync(join(tmpdir(), 'molio-explicit-'));
    const explicit = join(base, 'nested', 'docs');
    try {
      const vault = maybeCreateDefaultVault(db, watcher, {
        explicitPath: explicit,
        conventionPath: join(base, 'should-not-be-used'),
      });
      assert.ok(vault);
      assert.equal(vault.path, explicit);
      assert.equal(listVaults(db).length, 1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reads MOLIO_DEFAULT_VAULT_PATH when no explicit option is passed', () => {
    const base = mkdtempSync(join(tmpdir(), 'molio-envpath-'));
    const envPath = join(base, 'from-env');
    process.env[ENV_KEY] = envPath;
    try {
      const vault = maybeCreateDefaultVault(db, watcher, {
        conventionPath: join(base, 'should-not-be-used'),
      });
      assert.ok(vault);
      assert.equal(vault.path, envPath);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // Regression: on NAS/Docker the mounted docs dir is often root-owned while
  // the daemon runs unprivileged, so installing built-in skills into
  // <vault>/.claude/skills throws EACCES. Previously that throw aborted
  // provisioning AFTER createVault but BEFORE setActiveVaultId, leaving a vault
  // in the DB that was never selected — the user saw the empty welcome screen
  // and thought no knowledge base was created. Skill install failure must be a
  // non-fatal warning: the vault still gets created, watched, and activated.
  it('still creates + activates the vault when skill installation throws', () => {
    const mount = mkdtempSync(join(tmpdir(), 'molio-skillfail-'));
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const vault = maybeCreateDefaultVault(db, watcher, {
        conventionPath: mount,
        installSkills: () => {
          throw new Error('EACCES: permission denied, mkdir .claude/skills');
        },
      });
      assert.ok(vault, 'vault must still be created even though skill install failed');
      assert.equal(vault.path, mount);
      assert.equal(listVaults(db).length, 1);
      assert.equal(getActiveVaultId(db), vault.id, 'vault must still be set active');
      assert.deepEqual(watched, [[vault.id, mount]], 'watcher must still watch the new vault');
      assert.ok(
        warnings.some((w) => w.includes('skill installation failed')),
        'expected a warning about the failed skill installation',
      );
    } finally {
      console.warn = origWarn;
      rmSync(mount, { recursive: true, force: true });
    }
  });
});
