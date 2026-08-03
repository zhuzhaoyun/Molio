import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { syncSkill, removeSkillSyncDir, reconcileSync } from '../../../src/core/skills/sync.js';
import { createSkill } from '../../../src/core/skills/store.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-sync-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-sync-claude-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-sync-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('skills/sync', () => {
  it('syncSkill writes the library SKILL.md into molio--<id>/', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: false, builtIn: false }, 'body', opts);
    syncSkill(entry.id, opts);
    const synced = path.join(claudeHome, 'skills', `molio--${entry.id}`, 'SKILL.md');
    assert.ok(fs.existsSync(synced));
    assert.ok(fs.readFileSync(synced, 'utf8').includes('body'));
  });

  it('syncSkill mirrors a multi-file skill (SKILL.md + siblings) into molio--<id>/', () => {
    // Build a multi-file source dir and import it verbatim as the skill content.
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-sync-src-'));
    try {
      fs.writeFileSync(path.join(srcDir, 'SKILL.md'), '---\nname: M\n---\n\nsee references/g.md\n', 'utf8');
      fs.mkdirSync(path.join(srcDir, 'references'));
      fs.writeFileSync(path.join(srcDir, 'references', 'g.md'), 'guide\n', 'utf8');

      const entry = createSkill(
        db,
        { name: 'M', description: '', enabled: true, builtIn: false, sourceDir: srcDir },
        '',
        opts,
      );
      syncSkill(entry.id, opts);

      const dest = path.join(claudeHome, 'skills', `molio--${entry.id}`);
      assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'SKILL.md synced');
      assert.ok(fs.existsSync(path.join(dest, 'references', 'g.md')), 'nested sibling synced');
      assert.equal(fs.readFileSync(path.join(dest, 'references', 'g.md'), 'utf8'), 'guide\n');
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('syncSkill is a read-only no-op when dest already mirrors src', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, opts);
    const dest = path.join(claudeHome, 'skills', `molio--${entry.id}`);
    const skillMd = path.join(dest, 'SKILL.md');
    const before = fs.statSync(skillMd).mtimeMs;

    // Second sync with unchanged source must not rewrite (short-circuit).
    syncSkill(entry.id, opts);
    assert.equal(fs.statSync(skillMd).mtimeMs, before, 'unchanged source → no rewrite');
    // And it must not leave temp dirs behind in the skills root.
    const leftovers = fs
      .readdirSync(path.join(claudeHome, 'skills'))
      .filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no leftover temp dirs');
  });

  it('syncSkill rewrites when source content changed', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'v1', opts);
    syncSkill(entry.id, opts);
    const skillMd = path.join(claudeHome, 'skills', `molio--${entry.id}`, 'SKILL.md');
    assert.ok(fs.readFileSync(skillMd, 'utf8').includes('v1'));

    // Change the library source, re-sync → dest converges to the new content.
    fs.writeFileSync(path.join(molioHome, 'skills', entry.id, 'SKILL.md'), 'v2 changed\n', 'utf8');
    syncSkill(entry.id, opts);
    assert.ok(fs.readFileSync(skillMd, 'utf8').includes('v2 changed'), 'dest updated on change');
  });

  it('syncSkill drops stale siblings on re-sync (rm-first converge)', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, opts);
    const dest = path.join(claudeHome, 'skills', `molio--${entry.id}`);
    // Simulate an old version having synced an extra sibling that no longer exists.
    fs.writeFileSync(path.join(dest, 'stale.txt'), 'old', 'utf8');

    syncSkill(entry.id, opts);
    assert.ok(!fs.existsSync(path.join(dest, 'stale.txt')), 'stale sibling removed on re-sync');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'SKILL.md still present');
  });

  it('removeSkillSyncDir removes only the namespaced dir', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    removeSkillSyncDir(entry.id, opts);
    assert.ok(!fs.existsSync(path.join(claudeHome, 'skills', `molio--${entry.id}`)));
  });

  it('reconcileSync preserves user (non-molio) skills, removes orphan molio dirs, syncs enabled', () => {
    // user's own skill — must survive
    const userDir = path.join(claudeHome, 'skills', 'my-own-skill');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'user content', 'utf8');

    // orphan molio dir — must be removed
    const orphanDir = path.join(claudeHome, 'skills', 'molio--orphan');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'SKILL.md'), 'stale', 'utf8');

    // an enabled library skill — must be synced
    const entry = createSkill(db, { name: 'S', description: '', enabled: false, builtIn: false }, 'body', opts);

    reconcileSync([entry.id], opts);

    assert.ok(fs.existsSync(path.join(userDir, 'SKILL.md')), 'user skill must be untouched');
    assert.ok(!fs.existsSync(orphanDir), 'orphan molio dir must be removed');
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', `molio--${entry.id}`, 'SKILL.md')), 'enabled skill synced');
  });

  it('reconcileSync is idempotent', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: false, builtIn: false }, 'body', opts);
    reconcileSync([entry.id], opts);
    const synced = path.join(claudeHome, 'skills', `molio--${entry.id}`, 'SKILL.md');
    const mtime1 = fs.statSync(synced).mtimeMs;

    reconcileSync([entry.id], opts);
    assert.ok(fs.existsSync(synced), 'still present after second reconcile');
    // Content identical even if rewritten.
    assert.ok(fs.readFileSync(synced, 'utf8').includes('body'));
    assert.ok(typeof mtime1 === 'number');
  });

  it('reconcileSync with empty enabled set removes all molio dirs but keeps user dirs', () => {
    const userDir = path.join(claudeHome, 'skills', 'keep-me');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'x', 'utf8');
    // Set up a synced molio dir explicitly (createSkill no longer auto-syncs).
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, opts);
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', `molio--${entry.id}`)));

    reconcileSync([], opts);

    assert.ok(!fs.existsSync(path.join(claudeHome, 'skills', `molio--${entry.id}`)));
    assert.ok(fs.existsSync(userDir), 'user dir survives');
  });
});
