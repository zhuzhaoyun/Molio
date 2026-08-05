import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reconcileBundledSync, DEPRECATED_SKILLS } from '../../../src/core/skill-installer.js';

/**
 * reconcileBundledSync is the bundled-skill owner (skill-installer.ts). It is
 * driven entirely by the effective/managed slug sets computed from the `skills`
 * table (vault-config.ts). These tests use an INJECTED temp source dir so they
 * never depend on the real shipped skills, and pin:
 *   - whole-directory install (SKILL.md + sibling files),
 *   - removal of a managed-but-not-effective skill (toggled off),
 *   - the RED LINE: a slug NOT in the managed set is never touched, even with
 *     the same name as a real bundled skill (user's own dir is sacred),
 *   - deprecated-skill cleanup,
 *   - CLAUDE.md rule convergence to the effective set,
 *   - version-bump propagation to an existing vault.
 */

let sourceDir: string;
let vaultDir: string;

beforeEach(() => {
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-bundle-src-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-bundle-vault-'));
});

afterEach(() => {
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

/** Create a fake bundled skill source dir with a versioned SKILL.md + sibling files. */
function makeSourceSkill(slug: string, version = '1.0.0'): string {
  const dir = path.join(sourceDir, slug);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: fake ${slug}\nversion: ${version}\n---\n\nbody for ${slug}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'scripts', 'run.mjs'), 'console.log("hi");\n', 'utf8');
  return dir;
}

function skillDirInVault(slug: string): string {
  return path.join(vaultDir, '.claude', 'skills', slug);
}

function readClaudeMd(): string {
  return fs.readFileSync(path.join(vaultDir, '.claude', 'CLAUDE.md'), 'utf8');
}

describe('reconcileBundledSync', () => {
  it('installs an effective bundled skill as a WHOLE directory (SKILL.md + siblings)', () => {
    makeSourceSkill('docling');
    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });

    const dest = skillDirInVault('docling');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'SKILL.md copied');
    assert.ok(fs.existsSync(path.join(dest, 'scripts', 'run.mjs')), 'sibling files copied');
  });

  it('removes a managed skill that is no longer effective (toggled off)', () => {
    makeSourceSkill('docling');
    // First on: installed.
    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });
    assert.ok(fs.existsSync(skillDirInVault('docling')));

    // Then off (managed but not effective): removed.
    reconcileBundledSync(new Set(), new Set(['docling']), vaultDir, { sourceDir });
    assert.ok(!fs.existsSync(skillDirInVault('docling')), 'disabled bundled dir removed');
  });

  it('RED LINE: never touches a dir whose slug is not in the managed set (user dir)', () => {
    // User's own wiki-query dir — same name as a real bundled skill, but the DB
    // (managed set) knows nothing about it here.
    const userDir = skillDirInVault('wiki-query');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'user content', 'utf8');

    // Managed = docling only; wiki-query is NOT managed → must survive untouched.
    reconcileBundledSync(new Set(), new Set(['docling']), vaultDir, { sourceDir });

    assert.ok(fs.existsSync(path.join(userDir, 'SKILL.md')), 'unmanaged same-name dir survives');
    assert.equal(fs.readFileSync(path.join(userDir, 'SKILL.md'), 'utf8'), 'user content');
  });

  it('removes deprecated skills unconditionally (when they look Molio-installed)', () => {
    const deprecated = DEPRECATED_SKILLS[0];
    assert.ok(deprecated, 'there is at least one deprecated skill');
    const depDir = skillDirInVault(deprecated!);
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(path.join(depDir, 'SKILL.md'), 'old molio skill', 'utf8');

    reconcileBundledSync(new Set(), new Set(), vaultDir, { sourceDir });

    assert.ok(!fs.existsSync(depDir), `deprecated "${deprecated}" removed`);
  });

  it('converges CLAUDE.md rule blocks to the effective set (gate off removes, gate on adds)', () => {
    makeSourceSkill('docling');
    makeSourceSkill('remotion');

    // Both effective → both gated rule blocks present (plus always-on rules).
    reconcileBundledSync(new Set(['docling', 'remotion']), new Set(['docling', 'remotion']), vaultDir, {
      sourceDir,
    });
    let md = readClaudeMd();
    assert.ok(md.includes('<!-- molio:docling-preference -->'), 'docling rule present when effective');
    assert.ok(md.includes('<!-- molio:remotion-preference -->'), 'remotion rule present when effective');
    assert.ok(md.includes('<!-- molio:env-self-heal -->'), 'always-on rule present');

    // Drop docling from effective → its gated rule is removed, remotion stays.
    reconcileBundledSync(new Set(['remotion']), new Set(['docling', 'remotion']), vaultDir, { sourceDir });
    md = readClaudeMd();
    assert.ok(!md.includes('<!-- molio:docling-preference -->'), 'docling rule removed when toggled off');
    assert.ok(md.includes('<!-- molio:remotion-preference -->'), 'remotion rule kept');
    assert.ok(md.includes('<!-- molio:env-self-heal -->'), 'always-on rule kept');
  });

  it('updates an installed skill to a newer source version (version bump propagates)', () => {
    makeSourceSkill('docling', '1.0.0');
    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });
    const destSkill = path.join(skillDirInVault('docling'), 'SKILL.md');
    assert.match(fs.readFileSync(destSkill, 'utf8'), /version: 1\.0\.0/);

    // Bump the source version → existing vault gets the update on next reconcile.
    makeSourceSkill('docling', '2.0.0');
    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });
    assert.match(fs.readFileSync(destSkill, 'utf8'), /version: 2\.0\.0/, 'version bump propagated');
  });
});

/**
 * Step-3 removal guard: deletion demands OWNERSHIP PROOF (byte-for-byte mirror
 * of Molio's source). The previous "has a SKILL.md" guard was inverted — a
 * user's own same-named skill ALWAYS has a SKILL.md and would have been
 * rm -rf'd the moment the bundled skill toggled off.
 */
describe('reconcileBundledSync — ownership-proof removal', () => {
  it('NEVER deletes a user skill sharing a managed slug (user content differs from source)', () => {
    makeSourceSkill('docling');
    // The user's own `docling`, present while the DB has docling managed.
    const userDir = skillDirInVault('docling');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'my own docling setup\n', 'utf8');

    // Toggled off: managed but not effective → the old guard would rm -rf here.
    reconcileBundledSync(new Set(), new Set(['docling']), vaultDir, { sourceDir });

    assert.ok(fs.existsSync(path.join(userDir, 'SKILL.md')), 'user same-name dir survives toggle-off');
    assert.equal(
      fs.readFileSync(path.join(userDir, 'SKILL.md'), 'utf8'),
      'my own docling setup\n',
      'user content untouched',
    );
  });

  it('keeps a managed dir when the source is unreadable (no proof, no deletion)', () => {
    makeSourceSkill('docling');
    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });
    assert.ok(fs.existsSync(skillDirInVault('docling')));

    // Source vanishes (corrupted app resources): ownership is unprovable.
    fs.rmSync(path.join(sourceDir, 'docling'), { recursive: true, force: true });
    reconcileBundledSync(new Set(), new Set(['docling']), vaultDir, { sourceDir });

    assert.ok(fs.existsSync(skillDirInVault('docling')), 'without source there is no proof → no deletion');
  });
});

/** Strip END sentinels to reconstruct a pre-dual-sentinel (legacy) CLAUDE.md. */
function stripEndSentinels(md: string): string {
  return md.replace(/<!-- \/molio:[a-z0-9-]+ -->\r?\n/g, '');
}

/**
 * Rule blocks are wrapped in BEGIN/END sentinels so removal/replacement can
 * never touch user content written after (or between) blocks — the legacy
 * sentinel-to-next-sentinel extent deleted everything after the LAST block
 * (wiki-query) when it was toggled off.
 */
describe('reconcileBundledSync — BEGIN/END sentinel rule blocks', () => {
  it('writes rule blocks wrapped in BEGIN and END sentinels', () => {
    makeSourceSkill('docling');
    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });
    const md = readClaudeMd();
    assert.ok(md.includes('<!-- molio:docling-preference -->'), 'BEGIN present');
    assert.ok(md.includes('<!-- /molio:docling-preference -->'), 'END present');
    assert.ok(md.includes('<!-- /molio:env-self-heal -->'), 'always-on rule wrapped too');
    assert.ok(
      md.indexOf('<!-- /molio:docling-preference -->') > md.indexOf('<!-- molio:docling-preference -->'),
      'END comes after BEGIN',
    );
  });

  it('keeps user content written AFTER the last rule block when the gated rule toggles off', () => {
    makeSourceSkill('wiki-query');
    reconcileBundledSync(new Set(['wiki-query']), new Set(['wiki-query']), vaultDir, { sourceDir });
    // wiki-query's rule is the LAST block — the EOF-dangerous spot.
    fs.appendFileSync(
      path.join(vaultDir, '.claude', 'CLAUDE.md'),
      '\n## My own project rules\n\nDo not touch the legacy module.\n',
      'utf8',
    );

    reconcileBundledSync(new Set(), new Set(['wiki-query']), vaultDir, { sourceDir });

    const md = readClaudeMd();
    assert.ok(!md.includes('<!-- molio:wiki-query-preference -->'), 'gated rule removed');
    assert.ok(md.includes('## My own project rules'), 'user content after the last block survives');
    assert.ok(md.includes('Do not touch the legacy module.'));
  });

  it('legacy migration: toggling OFF an exact legacy block strips only the block, keeps trailing user content', () => {
    makeSourceSkill('wiki-query');
    reconcileBundledSync(new Set(['wiki-query']), new Set(['wiki-query']), vaultDir, { sourceDir });
    const mdPath = path.join(vaultDir, '.claude', 'CLAUDE.md');
    // Revert to legacy format (END sentinels gone) + user content after the last block.
    fs.writeFileSync(
      mdPath,
      stripEndSentinels(fs.readFileSync(mdPath, 'utf8')) + '\n## My rules\nkeep me\n',
      'utf8',
    );

    reconcileBundledSync(new Set(), new Set(['wiki-query']), vaultDir, { sourceDir });

    const md = readClaudeMd();
    assert.ok(!md.includes('<!-- molio:wiki-query-preference -->'), 'legacy block removed');
    assert.ok(md.includes('## My rules'), 'user content after the legacy block survives');
    assert.ok(md.includes('keep me'));
  });

  it('legacy migration: an active exact legacy block becomes wrapped and keeps trailing user content', () => {
    makeSourceSkill('wiki-query');
    reconcileBundledSync(new Set(['wiki-query']), new Set(['wiki-query']), vaultDir, { sourceDir });
    const mdPath = path.join(vaultDir, '.claude', 'CLAUDE.md');
    fs.writeFileSync(
      mdPath,
      stripEndSentinels(fs.readFileSync(mdPath, 'utf8')) + '\nUser notes after.\n',
      'utf8',
    );

    // Same effective set → migration pass into the wrapped format.
    reconcileBundledSync(new Set(['wiki-query']), new Set(['wiki-query']), vaultDir, { sourceDir });

    const md = readClaudeMd();
    assert.ok(md.includes('<!-- /molio:wiki-query-preference -->'), 'END sentinel added by migration');
    assert.ok(md.includes('User notes after.'), 'trailing user content survives migration');
    // Once migrated, toggling off is precise (wrapped extent) — content still safe.
    reconcileBundledSync(new Set(), new Set(['wiki-query']), vaultDir, { sourceDir });
    const after = readClaudeMd();
    assert.ok(!after.includes('<!-- molio:wiki-query-preference -->'));
    assert.ok(after.includes('User notes after.'), 'content still safe after migrated toggle-off');
  });

  it('legacy migration: a DRIFTED legacy block is replaced wholesale once (unknowable boundary)', () => {
    makeSourceSkill('docling');
    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });
    const mdPath = path.join(vaultDir, '.claude', 'CLAUDE.md');
    // Legacy format + user text injected INSIDE the docling block → drift: the
    // block boundary is unknowable, so the whole legacy extent is replaced once.
    const legacy = stripEndSentinels(fs.readFileSync(mdPath, 'utf8')).replace(
      '<!-- molio:docling-preference -->',
      '<!-- molio:docling-preference -->\nuser injected line',
    );
    fs.writeFileSync(mdPath, legacy, 'utf8');

    reconcileBundledSync(new Set(['docling']), new Set(['docling']), vaultDir, { sourceDir });

    const md = readClaudeMd();
    assert.ok(!md.includes('user injected line'), 'drifted legacy extent replaced');
    assert.ok(md.includes('<!-- /molio:docling-preference -->'), 'converged to wrapped format');
  });
});
