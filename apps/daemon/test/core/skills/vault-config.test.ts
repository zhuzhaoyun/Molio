import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../../src/core/db.js';
import { createSkill } from '../../../src/core/skills/store.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';
import {
  getVaultSkillOverrides,
  setVaultSkillEnabled,
  getEffectiveSkillIds,
  reconcileVault,
  reconcileAllVaults,
  cleanupLegacyGlobalSync,
  deleteVaultSkillOverrides,
} from '../../../src/core/skills/vault-config.js';

/**
 * Per-vault skill config tests. Everything is isolated in temp dirs:
 *  - `molioHome` holds the skill library (manifest + SKILL.md sources);
 *  - each vault is its own temp dir (the sync target `<vault>/.claude/skills`);
 *  - the SQLite db lives in a temp dir via openDatabase(dbDir).
 * cleanupLegacyGlobalSync is always given an explicit temp `claudeHome`, so the
 * real `~/.claude` is never touched.
 */

let molioHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vc-home-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vc-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome };
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

/** Make a temp vault dir + register it, returning both. */
function makeVault(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vc-vault-'));
  const vault = createVault(db, name, dir, '');
  return { dir, vault };
}

/** Path to a synced skill dir inside a vault's .claude/skills. */
function molioDirIn(vaultDir: string, id: string): string {
  return path.join(vaultDir, '.claude', 'skills', `molio--${id}`);
}

describe('skills/vault-config', () => {
  // ── overrides ──

  it('getVaultSkillOverrides is empty for a fresh vault', () => {
    const { vault } = makeVault('V');
    assert.equal(getVaultSkillOverrides(db, vault.id).size, 0);
  });

  it('setVaultSkillEnabled upserts (one row per skill, latest value wins)', () => {
    const { vault } = makeVault('V');
    setVaultSkillEnabled(db, vault.id, 's1', false);
    setVaultSkillEnabled(db, vault.id, 's1', false); // repeat — no duplicate
    setVaultSkillEnabled(db, vault.id, 's1', true); // flip

    const overrides = getVaultSkillOverrides(db, vault.id);
    assert.equal(overrides.size, 1, 'still a single row');
    assert.equal(overrides.get('s1'), true, 'latest value wins');
  });

  // ── effective set (four-cell precedence matrix) ──

  it('getEffectiveSkillIds: globally-enabled AND not disabled in vault', () => {
    const { vault } = makeVault('V');
    createSkill(db, { id: 'a', name: 'A', description: '', enabled: true, builtIn: false }, 'body', opts);
    createSkill(db, { id: 'b', name: 'B', description: '', enabled: true, builtIn: false }, 'body', opts);
    createSkill(db, { id: 'c', name: 'C', description: '', enabled: false, builtIn: false }, 'body', opts);
    createSkill(db, { id: 'd', name: 'D', description: '', enabled: false, builtIn: false }, 'body', opts);

    setVaultSkillEnabled(db, vault.id, 'b', false); // vault disables a global-on skill
    setVaultSkillEnabled(db, vault.id, 'c', true); // vault tries to enable a global-off skill

    // a: global on, no override → in
    // b: global on, vault off → out
    // c: global off, vault on → out (global wins — can't enable what's globally off)
    // d: global off, no override → out
    assert.deepEqual(getEffectiveSkillIds(db, vault.id), ['a']);
  });

  // ── reconcileVault ──

  it('reconcileVault syncs effective skills and removes orphans, never touching non-molio dirs', () => {
    const { dir, vault } = makeVault('V');
    createSkill(db, { id: 'keep', name: 'Keep', description: '', enabled: true, builtIn: false }, 'body', opts);
    createSkill(db, { id: 'off', name: 'Off', description: '', enabled: false, builtIn: false }, 'body', opts);

    const skillsRoot = path.join(dir, '.claude', 'skills');
    // Pre-existing dirs that must survive (red line): a builtin + a user skill.
    fs.mkdirSync(path.join(skillsRoot, 'wiki-query'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'wiki-query', 'SKILL.md'), 'builtin');
    fs.mkdirSync(path.join(skillsRoot, 'my-own'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'my-own', 'SKILL.md'), 'user');
    // A stale molio orphan that must be cleaned up.
    fs.mkdirSync(path.join(skillsRoot, 'molio--stale'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'molio--stale', 'SKILL.md'), 'old');

    reconcileVault(db, vault, opts);

    assert.ok(fs.existsSync(path.join(molioDirIn(dir, 'keep'), 'SKILL.md')), 'effective skill synced');
    assert.ok(!fs.existsSync(molioDirIn(dir, 'off')), 'non-effective skill not present');
    assert.ok(!fs.existsSync(path.join(skillsRoot, 'molio--stale')), 'orphan molio-- dir removed');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'wiki-query', 'SKILL.md')), 'builtin dir untouched');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'my-own', 'SKILL.md')), 'user dir untouched');
  });

  it('reconcileVault is idempotent', () => {
    const { dir, vault } = makeVault('V');
    createSkill(db, { id: 'x', name: 'X', description: '', enabled: true, builtIn: false }, 'body', opts);

    reconcileVault(db, vault, opts);
    reconcileVault(db, vault, opts);

    assert.ok(fs.existsSync(path.join(molioDirIn(dir, 'x'), 'SKILL.md')));
    const entries = fs.readdirSync(path.join(dir, '.claude', 'skills')).filter((e) => e.startsWith('molio--'));
    assert.deepEqual(entries, ['molio--x']);
  });

  it('reconcileVault removes a skill that gets disabled after being synced', () => {
    const { dir, vault } = makeVault('V');
    createSkill(db, { id: 'y', name: 'Y', description: '', enabled: true, builtIn: false }, 'body', opts);
    reconcileVault(db, vault, opts);
    assert.ok(fs.existsSync(molioDirIn(dir, 'y')));

    setVaultSkillEnabled(db, vault.id, 'y', false);
    reconcileVault(db, vault, opts);
    assert.ok(!fs.existsSync(molioDirIn(dir, 'y')), 'per-vault disable removes the dir');
  });

  // ── reconcileAllVaults ──

  it('reconcileAllVaults fans out to every vault', () => {
    const v1 = makeVault('V1');
    const v2 = makeVault('V2');
    createSkill(db, { id: 'all', name: 'All', description: '', enabled: true, builtIn: false }, 'body', opts);

    reconcileAllVaults(db, opts);

    assert.ok(fs.existsSync(path.join(molioDirIn(v1.dir, 'all'), 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(molioDirIn(v2.dir, 'all'), 'SKILL.md')));

    fs.rmSync(v1.dir, { recursive: true, force: true });
    fs.rmSync(v2.dir, { recursive: true, force: true });
  });

  // ── cleanupLegacyGlobalSync ──

  it('cleanupLegacyGlobalSync removes legacy molio--* dirs from the given claudeHome only', () => {
    const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vc-legacy-'));
    try {
      const legacySkills = path.join(legacyHome, 'skills');
      fs.mkdirSync(path.join(legacySkills, 'molio--legacy'), { recursive: true });
      fs.writeFileSync(path.join(legacySkills, 'molio--legacy', 'SKILL.md'), 'old');
      // A non-molio dir that must survive even in the legacy cleanup.
      fs.mkdirSync(path.join(legacySkills, 'user-skill'), { recursive: true });
      fs.writeFileSync(path.join(legacySkills, 'user-skill', 'SKILL.md'), 'user');

      cleanupLegacyGlobalSync({ claudeHome: legacyHome, molioHome });

      assert.ok(!fs.existsSync(path.join(legacySkills, 'molio--legacy')), 'legacy molio-- removed');
      assert.ok(fs.existsSync(path.join(legacySkills, 'user-skill')), 'user skill untouched');
    } finally {
      fs.rmSync(legacyHome, { recursive: true, force: true });
    }
  });

  // ── deleteVaultSkillOverrides ──

  it('deleteVaultSkillOverrides drops a skill\'s overrides across all vaults', () => {
    const v1 = makeVault('V1');
    const v2 = makeVault('V2');
    setVaultSkillEnabled(db, v1.vault.id, 'gone', false);
    setVaultSkillEnabled(db, v2.vault.id, 'gone', false);
    setVaultSkillEnabled(db, v1.vault.id, 'stays', false);

    deleteVaultSkillOverrides(db, 'gone');

    assert.equal(getVaultSkillOverrides(db, v1.vault.id).has('gone'), false);
    assert.equal(getVaultSkillOverrides(db, v2.vault.id).has('gone'), false);
    assert.equal(getVaultSkillOverrides(db, v1.vault.id).get('stays'), false, 'unrelated override kept');

    fs.rmSync(v1.dir, { recursive: true, force: true });
    fs.rmSync(v2.dir, { recursive: true, force: true });
  });
});
