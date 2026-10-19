import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import {
  openDatabase, closeDatabase, listVaults, createVault,
} from '../../src/core/db.js';
import {
  createSampleVault,
  resolveSampleVaultPath,
  resolveSampleVaultSourceDir,
  SampleVaultPathError,
  SAMPLE_VAULT_ENTRY,
} from '../../src/core/sample-vault.js';

function writeSource(dir: string) {
  mkdirSync(join(dir, '使用手册'), { recursive: true });
  writeFileSync(join(dir, SAMPLE_VAULT_ENTRY), '# 开始使用\n');
  writeFileSync(join(dir, '使用手册', '导入文件.md'), '# 导入文件\n');
}

describe('sample vault core', () => {
  let dataDir: string;
  let root: string;
  let sourceDir: string;
  let target: string;
  let db: ReturnType<typeof openDatabase>;
  let watched: Array<[string, string]>;
  const watcher = {
    watch(vaultId: string, vaultPath: string) { watched.push([vaultId, vaultPath]); },
  };

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'molio-sample-db-'));
    db = openDatabase(dataDir);
  });

  after(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'molio-sample-case-'));
    sourceDir = join(root, 'source');
    target = join(root, 'target');
    writeSource(sourceDir);
    watched = [];
  });

  afterEach(() => {
    for (const v of listVaults(db)) db.prepare('DELETE FROM vaults WHERE id = ?').run(v.id);
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the directory, copies every file, registers the vault and watches it', () => {
    const result = createSampleVault(db, watcher, { samplePath: target, sourceDir });
    assert.equal(result.created, true);
    assert.equal(result.entryFile, SAMPLE_VAULT_ENTRY);
    assert.equal(result.vault.path, target);
    assert.equal(readFileSync(join(target, SAMPLE_VAULT_ENTRY), 'utf-8'), '# 开始使用\n');
    assert.ok(existsSync(join(target, '使用手册', '导入文件.md')));
    assert.equal(listVaults(db).length, 1);
    assert.deepEqual(watched, [[result.vault.id, target]]);
  });

  it('is idempotent — a second call returns the same vault with created:false', () => {
    const first = createSampleVault(db, watcher, { samplePath: target, sourceDir });
    const second = createSampleVault(db, watcher, { samplePath: target, sourceDir });
    assert.equal(second.created, false);
    assert.equal(second.vault.id, first.vault.id);
    assert.equal(listVaults(db).length, 1);
  });

  it('never overwrites a file the user edited', () => {
    createSampleVault(db, watcher, { samplePath: target, sourceDir });
    const entry = join(target, SAMPLE_VAULT_ENTRY);
    writeFileSync(entry, '# 我自己改过的内容\n');
    createSampleVault(db, watcher, { samplePath: target, sourceDir });
    assert.equal(readFileSync(entry, 'utf-8'), '# 我自己改过的内容\n');
  });

  it('fills only missing files when the directory was partially deleted', () => {
    createSampleVault(db, watcher, { samplePath: target, sourceDir });
    const manual = join(target, '使用手册', '导入文件.md');
    rmSync(manual);
    createSampleVault(db, watcher, { samplePath: target, sourceDir });
    assert.ok(existsSync(manual), 'missing file should be restored');
  });

  it('re-registers a directory whose metadata was deleted, without duplicating files', () => {
    const first = createSampleVault(db, watcher, { samplePath: target, sourceDir });
    db.prepare('DELETE FROM vaults WHERE id = ?').run(first.vault.id);
    const second = createSampleVault(db, watcher, { samplePath: target, sourceDir });
    assert.equal(second.created, true);
    assert.notEqual(second.vault.id, first.vault.id);
    assert.equal(listVaults(db).length, 1);
  });

  it('fails before touching disk or DB when the source directory is missing', () => {
    rmSync(sourceDir, { recursive: true, force: true });
    assert.throws(
      () => createSampleVault(db, watcher, { samplePath: target, sourceDir }),
      /Sample vault source not found/,
    );
    assert.equal(listVaults(db).length, 0);
    assert.equal(existsSync(target), false);
  });

  it('rejects a target nested inside an existing vault and keeps the DB clean', () => {
    const existing = mkdtempSync(join(root, 'existing-'));
    createVault(db, 'existing', existing);
    const nested = join(existing, '示例知识库');
    assert.throws(
      () => createSampleVault(db, watcher, { samplePath: nested, sourceDir }),
      (err: unknown) => err instanceof SampleVaultPathError && err.code === 'VAULT_PATH_NESTED',
    );
    assert.equal(listVaults(db).length, 1);
    assert.equal(existsSync(nested), false);
  });
});

describe('resolveSampleVaultPath', () => {
  let home: string;
  const ENV_KEYS = ['MOLIO_SAMPLE_VAULT_PATH', 'MOLIO_DOCUMENTS_DIR'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'molio-home-'));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('prefers the explicit samplePath', () => {
    const explicit = join(home, 'explicit');
    const docs = join(home, 'docs');
    assert.equal(
      resolveSampleVaultPath({ samplePath: explicit, documentsDir: docs, homeDir: home }),
      explicit,
    );
  });

  it('uses the injected documents dir when no explicit path is given', () => {
    const docs = join(home, 'docs');
    assert.equal(
      resolveSampleVaultPath({ documentsDir: docs, homeDir: home }),
      join(docs, 'Molio', '示例知识库'),
    );
  });

  it('falls back to <home>/Documents when it exists', () => {
    mkdirSync(join(home, 'Documents'));
    assert.equal(
      resolveSampleVaultPath({ homeDir: home }),
      join(home, 'Documents', 'Molio', '示例知识库'),
    );
  });

  it('falls back to ~/.molio/sample-vault when there is no Documents directory', () => {
    assert.equal(
      resolveSampleVaultPath({ homeDir: home }),
      join(home, '.molio', 'sample-vault'),
    );
  });
});

describe('resolveSampleVaultSourceDir', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'molio-src-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('finds the dev layout: <base>/../tools/sample-vault', () => {
    const base = join(root, 'src', 'core');
    const dev = join(root, 'src', 'tools', 'sample-vault');
    writeSource(dev);
    assert.equal(resolveSampleVaultSourceDir({ baseDir: base }), dev);
  });

  it('finds the packaged layout: <base>/sample-vault', () => {
    const base = join(root, 'resources', 'daemon');
    const packaged = join(base, 'sample-vault');
    writeSource(packaged);
    assert.equal(resolveSampleVaultSourceDir({ baseDir: base }), packaged);
  });

  it('finds the tsc layout: <base>/../../../src/tools/sample-vault', () => {
    const base = join(root, 'dist', 'src', 'core');
    const prod = join(root, 'src', 'tools', 'sample-vault');
    writeSource(prod);
    assert.equal(resolveSampleVaultSourceDir({ baseDir: base }), prod);
  });
});
