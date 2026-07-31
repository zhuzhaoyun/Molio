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
