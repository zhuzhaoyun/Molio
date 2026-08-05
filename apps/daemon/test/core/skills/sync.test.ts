import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { syncSkill, reconcileSync } from '../../../src/core/skills/sync.js';
import { copyDirSync, isAlreadySynced } from '../../../src/core/skills/dirsync.js';
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

  it('syncSkill removes the stale mirror when the library source dir vanished', () => {
    // Regression: the source dir can vanish (manual deletion, disk cleanup,
    // corrupted home) while the DB row lives on. The id stays in enabledIds,
    // so the orphan cleanup SKIPS it — without an explicit removal the outdated
    // copy stays in every vault and runtime CLIs load it forever.
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, opts);
    const dest = path.join(claudeHome, 'skills', `molio--${entry.id}`);
    assert.ok(fs.existsSync(dest), 'mirror created first');

    fs.rmSync(path.join(molioHome, 'skills', entry.id), { recursive: true, force: true });
    syncSkill(entry.id, opts);

    assert.ok(!fs.existsSync(dest), 'stale mirror removed when the source is gone');
  });

  it('reconcileSync sweeps stale mirror staging dirs but keeps fresh ones', () => {
    // A daemon killed mid-mirror leaves `.tmp-*`/`.bak-*` staging dirs inside
    // the scanned skills dir — runtime CLIs would load a half-copied skill.
    const skillsDir = path.join(claudeHome, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const staleTmp = path.join(skillsDir, 'molio--x.tmp-1700000000000-aaa111');
    const staleBak = path.join(skillsDir, 'molio--y.bak-1700000000000-bbb222');
    const freshTmp = path.join(skillsDir, `molio--z.tmp-${Date.now()}-ccc333`);
    for (const d of [staleTmp, staleBak, freshTmp]) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'SKILL.md'), 'staging\n', 'utf8');
    }
    // Backdate the stale pair past the 5-minute in-flight grace window.
    const oldSec = (Date.now() - 10 * 60 * 1000) / 1000;
    fs.utimesSync(staleTmp, oldSec, oldSec);
    fs.utimesSync(staleBak, oldSec, oldSec);

    reconcileSync([], opts);

    assert.ok(!fs.existsSync(staleTmp), 'stale .tmp staging dir swept');
    assert.ok(!fs.existsSync(staleBak), 'stale .bak staging dir swept');
    assert.ok(fs.existsSync(freshTmp), 'fresh staging dir (possibly in flight) kept');
  });

  it('reconcileSync ignores non-directory molio-- entries without crashing', () => {
    // NAS mounts can surface stray files/junctions; the orphan scan is
    // directory-only and must skip anything else silently.
    const skillsDir = path.join(claudeHome, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const stray = path.join(skillsDir, 'molio--stray-file');
    fs.writeFileSync(stray, 'x', 'utf8');

    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    reconcileSync([entry.id], opts); // must not throw

    assert.ok(fs.existsSync(stray), 'non-directory entries are left alone');
    assert.ok(fs.existsSync(path.join(skillsDir, `molio--${entry.id}`, 'SKILL.md')));
  });

  it('mirroring skips symlinks entirely (no follow, no copy, hash parity kept)', (t) => {
    // Symlinks must never be followed into the mirror: a link to a directory
    // used to crash copyFileSync (EISDIR) and a link out would leak external
    // content into the vault. Skipping them keeps hash parity, so the
    // short-circuit still works.
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-symlink-src-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-symlink-out-'));
    try {
      fs.writeFileSync(path.join(src, 'SKILL.md'), 'body\n', 'utf8');
      const external = path.join(outside, 'external.txt');
      fs.writeFileSync(external, 'external content\n', 'utf8');
      try {
        fs.symlinkSync(external, path.join(src, 'link.txt'));
      } catch {
        t.skip('symlink creation needs elevated privileges on this platform');
        return;
      }

      const dest = path.join(outside, 'mirror');
      copyDirSync(src, dest);

      assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'regular files copied');
      assert.ok(!fs.existsSync(path.join(dest, 'link.txt')), 'symlink NOT copied');
      assert.ok(isAlreadySynced(src, dest), 'hash parity holds despite the skipped symlink');
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
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
