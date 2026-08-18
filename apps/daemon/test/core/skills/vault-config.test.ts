import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../../src/core/db.js';
import { createSkill, toggleSkill, updateSkill } from '../../../src/core/skills/store.js';
import { slugifySkillName, type SkillPathsOpts } from '../../../src/core/skills/paths.js';
import {
  getEffectiveSkillIds,
  reconcileVault,
  reconcileAllVaults,
  reconcileAllVaultsAsync,
  cleanupLegacyGlobalSync,
} from '../../../src/core/skills/vault-config.js';
import { resolveSkillsSourceDir } from '../../../src/core/skill-installer.js';


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

/** Path to a synced skill dir inside a vault's .claude/skills (name-based). */
function molioDirIn(vaultDir: string, displayName: string): string {
  return path.join(vaultDir, '.claude', 'skills', `molio--${slugifySkillName(displayName)}`);
}

describe('skills/vault-config', () => {
  // ── effective set: globally-enabled OR bundled, same for every vault ──

  it('getEffectiveSkillIds: globally-enabled OR bundled (app-owned ignores the switch)', () => {
    const { vault } = makeVault('V');
    createSkill(db, { id: 'a', name: 'A', description: '', enabled: true, builtIn: false }, 'body', opts);
    createSkill(db, { id: 'b', name: 'B', description: '', enabled: false, builtIn: false }, 'body', opts);
    createSkill(db, { id: 'd', name: 'D', description: '', enabled: false, builtIn: true, kind: 'bundled' }, '', opts);

    // a: global on → in
    // b: global off → out
    // d: bundled → in even though globally disabled (hidden app functionality,
    //    wired into deterministic app paths; the switch is ignored)
    assert.deepEqual(getEffectiveSkillIds(db, vault.id), ['a', 'd']);
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

    assert.ok(fs.existsSync(path.join(molioDirIn(dir, 'Keep'), 'SKILL.md')), 'effective skill synced');
    assert.ok(!fs.existsSync(molioDirIn(dir, 'Off')), 'non-effective skill not present');
    assert.ok(!fs.existsSync(path.join(skillsRoot, 'molio--stale')), 'orphan molio-- dir removed');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'wiki-query', 'SKILL.md')), 'builtin dir untouched');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'my-own', 'SKILL.md')), 'user dir untouched');
  });

  it('reconcileVault is idempotent', () => {
    const { dir, vault } = makeVault('V');
    createSkill(db, { id: 'x', name: 'X', description: '', enabled: true, builtIn: false }, 'body', opts);

    reconcileVault(db, vault, opts);
    reconcileVault(db, vault, opts);

    assert.ok(fs.existsSync(path.join(molioDirIn(dir, 'X'), 'SKILL.md')));
    const entries = fs.readdirSync(path.join(dir, '.claude', 'skills')).filter((e) => e.startsWith('molio--'));
    assert.deepEqual(entries, ['molio--x']);
  });

  it('reconcileVault converges the vault dir when a skill is renamed', () => {
    // The vault dir follows the display name: renaming must remove the old
    // slug's dir and create the new one on the next reconcile (orphan cleanup
    // keyed on the planned dir-name set does this automatically).
    const { dir, vault } = makeVault('V');
    const entry = createSkill(db, { name: 'Old Name', description: '', enabled: true, builtIn: false }, 'body', opts);
    reconcileVault(db, vault, opts);
    assert.ok(fs.existsSync(molioDirIn(dir, 'Old Name')));

    updateSkill(db, entry.id, { name: 'New Name' }, opts);
    reconcileVault(db, vault, opts);
    assert.ok(!fs.existsSync(molioDirIn(dir, 'Old Name')), 'old slug dir removed');
    assert.ok(fs.existsSync(path.join(molioDirIn(dir, 'New Name'), 'SKILL.md')), 'new slug dir synced');
  });

  it('reconcileVault removes a skill that gets disabled after being synced', () => {
    const { dir, vault } = makeVault('V');
    createSkill(db, { id: 'y', name: 'Y', description: '', enabled: true, builtIn: false }, 'body', opts);
    reconcileVault(db, vault, opts);
    assert.ok(fs.existsSync(molioDirIn(dir, 'Y')));

    toggleSkill(db, 'y', false);
    reconcileVault(db, vault, opts);
    assert.ok(!fs.existsSync(molioDirIn(dir, 'Y')), 'global disable removes the dir');
  });

  // ── reconcileAllVaults ──

  it('reconcileAllVaults fans out to every vault', () => {
    const v1 = makeVault('V1');
    const v2 = makeVault('V2');
    createSkill(db, { id: 'all', name: 'All', description: '', enabled: true, builtIn: false }, 'body', opts);

    reconcileAllVaults(db, opts);

    assert.ok(fs.existsSync(path.join(molioDirIn(v1.dir, 'All'), 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(molioDirIn(v2.dir, 'All'), 'SKILL.md')));

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
});

describe('skills/vault-config: reconcileAllVaultsAsync (startup fan-out must not block)', () => {
  // Regression: the daemon's startup fan-out ran fully synchronously; with
  // ~1.2s of fs work per vault on a cold cache (13+ vaults ≈ 16s) the event
  // loop was blocked until long after the desktop shell's startup timeout —
  // "后端服务启动失败" on every first launch after packaging.

  it('fans out to every vault like the sync variant', async () => {
    const v1 = makeVault('V1');
    const v2 = makeVault('V2');
    createSkill(db, { id: 'all', name: 'All', description: '', enabled: true, builtIn: false }, 'body', opts);

    await reconcileAllVaultsAsync(db, opts);

    assert.ok(fs.existsSync(path.join(molioDirIn(v1.dir, 'All'), 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(molioDirIn(v2.dir, 'All'), 'SKILL.md')));

    fs.rmSync(v1.dir, { recursive: true, force: true });
    fs.rmSync(v2.dir, { recursive: true, force: true });
  });

  it('yields to the event loop between vaults', async () => {
    const vaults = [makeVault('V1'), makeVault('V2'), makeVault('V3')];
    createSkill(db, { id: 's', name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);

    let ticks = 0;
    let ticking = true;
    const tick = (): void => {
      if (!ticking) return;
      ticks++;
      setImmediate(tick);
    };
    setImmediate(tick);

    await reconcileAllVaultsAsync(db, opts);
    ticking = false;

    // 3 vaults → 3 inter-vault yields → at least 2 interleaved ticks.
    assert.ok(ticks >= 2, `expected >= 2 interleaved event-loop ticks, got ${ticks}`);

    for (const v of vaults) {
      fs.rmSync(v.dir, { recursive: true, force: true });
    }
  });
});

describe('skills/vault-config: retired bundled skill cleanup (remotion)', () => {
  // remotion is no longer bundled (video creation moved to the skill hub's
  // am-will/remotion). Vaults synced by older versions still carry the
  // app-owned copy under .claude/skills/remotion/ PLUS the gated CLAUDE.md
  // rule block — reconcileVault must clean up both:
  //  - the DB row is deleted on startup (builtin.ts step 0), but
  //    RETIRED_BUNDLED_SKILLS keeps the slug in the MANAGED set so the
  //    step-3 removal fires (with the usual byte-for-byte ownership proof);
  //  - the rule's gateSlug is never effective, so ensureMolioRules strips
  //    the block by sentinel.

  it('removes the stale per-vault remotion dir and its CLAUDE.md rule block', () => {
    const { dir, vault } = makeVault('V');
    // Post-upgrade DB shape: the usual bundled rows exist, remotion's is gone
    // (deleted by builtin.ts step 0). Seed docling so the test can also prove
    // the rest of the bundled sync keeps working alongside the cleanup.
    const now = Date.now();
    db.prepare(
      `INSERT INTO skills (id, name, description, kind, core, built_in, enabled, created_at, updated_at)
       VALUES ('docling', 'docling', '', 'bundled', 0, 1, 1, ?, ?)`,
    ).run(now, now);
    const sourceDir = resolveSkillsSourceDir();
    const remotionSrc = path.join(sourceDir, 'remotion');
    assert.ok(
      fs.existsSync(path.join(remotionSrc, 'SKILL.md')),
      'the shipped remotion source dir must be KEPT — it is the ownership proof for removal',
    );

    // Simulate an old-version install: a byte-for-byte copy of the app-owned
    // skill + the wrapped rule block in CLAUDE.md.
    const staleDir = path.join(dir, '.claude', 'skills', 'remotion');
    fs.cpSync(remotionSrc, staleDir, { recursive: true });
    const claudeDir = path.join(dir, '.claude');
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), [
      '# Vault rules',
      '',
      '<!-- molio:remotion-preference -->',
      'legacy remotion block body',
      '<!-- /molio:remotion-preference -->',
      '',
      'User content after the block.',
    ].join('\n'), 'utf-8');

    reconcileVault(db, vault, opts);

    assert.ok(!fs.existsSync(staleDir), 'stale bundled remotion copy must be removed (ownership proven)');
    const md = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8');
    assert.ok(!md.includes('<!-- molio:remotion-preference -->'), 'legacy rule block removed by sentinel');
    assert.ok(md.includes('User content after the block.'), 'user content survives the cleanup');
    // The rest of the bundled system keeps working.
    assert.ok(
      fs.existsSync(path.join(dir, '.claude', 'skills', 'docling', 'SKILL.md')),
      'docling is still synced',
    );
  });

  it('never removes a USER remotion dir (no ownership proof)', () => {
    const { dir, vault } = makeVault('V');
    const userDir = path.join(dir, '.claude', 'skills', 'remotion');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'my own remotion setup\n', 'utf-8');

    reconcileVault(db, vault, opts);

    assert.ok(
      fs.existsSync(path.join(userDir, 'SKILL.md')),
      'user same-name dir survives — its content differs from the shipped source',
    );
  });
});
