import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { syncSkill, reconcileSync, planSyncTargets } from '../../../src/core/skills/sync.js';
import { copyDirSync, isAlreadySynced } from '../../../src/core/skills/dirsync.js';
import { createSkill } from '../../../src/core/skills/store.js';
import { slugifySkillName, type SkillPathsOpts } from '../../../src/core/skills/paths.js';

/** Dir a library skill named `name` syncs into under the molio-- prefix. */
function molioDir(name: string): string {
  return `molio--${slugifySkillName(name)}`;
}

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
  it('syncSkill writes the library SKILL.md into molio--<dirName>/ (slugified display name)', () => {
    const entry = createSkill(db, { name: 'My Skill', description: '', enabled: false, builtIn: false }, 'body', opts);
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    const synced = path.join(claudeHome, 'skills', molioDir('My Skill'), 'SKILL.md');
    assert.ok(fs.existsSync(synced));
    assert.ok(fs.readFileSync(synced, 'utf8').includes('body'));
    // The vault dir is name-based — the DB uuid must NOT appear in the path.
    assert.ok(!fs.existsSync(path.join(claudeHome, 'skills', `molio--${entry.id}`)));
  });

  it('syncSkill mirrors a multi-file skill (SKILL.md + siblings) into molio--<dirName>/', () => {
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
      syncSkill(entry.id, slugifySkillName(entry.name), opts);

      const dest = path.join(claudeHome, 'skills', molioDir('M'));
      assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'SKILL.md synced');
      assert.ok(fs.existsSync(path.join(dest, 'references', 'g.md')), 'nested sibling synced');
      assert.equal(fs.readFileSync(path.join(dest, 'references', 'g.md'), 'utf8'), 'guide\n');
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('syncSkill is a read-only no-op when dest already mirrors src', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    const dest = path.join(claudeHome, 'skills', molioDir('S'));
    const skillMd = path.join(dest, 'SKILL.md');
    const before = fs.statSync(skillMd).mtimeMs;

    // Second sync with unchanged source must not rewrite (short-circuit).
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    assert.equal(fs.statSync(skillMd).mtimeMs, before, 'unchanged source → no rewrite');
    // And it must not leave temp dirs behind in the skills root.
    const leftovers = fs
      .readdirSync(path.join(claudeHome, 'skills'))
      .filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no leftover temp dirs');
  });

  it('syncSkill rewrites when source content changed', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'v1', opts);
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    const skillMd = path.join(claudeHome, 'skills', molioDir('S'), 'SKILL.md');
    assert.ok(fs.readFileSync(skillMd, 'utf8').includes('v1'));

    // Change the library source, re-sync → dest converges to the new content.
    fs.writeFileSync(path.join(molioHome, 'skills', entry.id, 'SKILL.md'), 'v2 changed\n', 'utf8');
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    assert.ok(fs.readFileSync(skillMd, 'utf8').includes('v2 changed'), 'dest updated on change');
  });

  it('syncSkill drops stale siblings on re-sync (rm-first converge)', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    const dest = path.join(claudeHome, 'skills', molioDir('S'));
    // Simulate an old version having synced an extra sibling that no longer exists.
    fs.writeFileSync(path.join(dest, 'stale.txt'), 'old', 'utf8');

    syncSkill(entry.id, slugifySkillName(entry.name), opts);
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

    reconcileSync(planSyncTargets([entry]), opts);

    assert.ok(fs.existsSync(path.join(userDir, 'SKILL.md')), 'user skill must be untouched');
    assert.ok(!fs.existsSync(orphanDir), 'orphan molio dir must be removed');
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', molioDir('S'), 'SKILL.md')), 'enabled skill synced');
  });

  it('reconcileSync is idempotent', () => {
    const entry = createSkill(db, { name: 'S', description: '', enabled: false, builtIn: false }, 'body', opts);
    reconcileSync(planSyncTargets([entry]), opts);
    const synced = path.join(claudeHome, 'skills', molioDir('S'), 'SKILL.md');
    const mtime1 = fs.statSync(synced).mtimeMs;

    reconcileSync(planSyncTargets([entry]), opts);
    assert.ok(fs.existsSync(synced), 'still present after second reconcile');
    // Content identical even if rewritten.
    assert.ok(fs.readFileSync(synced, 'utf8').includes('body'));
    assert.ok(typeof mtime1 === 'number');
  });

  it('syncSkill removes the stale mirror when the library source dir vanished', () => {
    // Regression: the source dir can vanish (manual deletion, disk cleanup,
    // corrupted home) while the DB row lives on. The target stays in the
    // planned set, so the orphan cleanup SKIPS it — without an explicit
    // removal the outdated copy stays in every vault and runtime CLIs load it
    // forever.
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    const dest = path.join(claudeHome, 'skills', molioDir('S'));
    assert.ok(fs.existsSync(dest), 'mirror created first');

    fs.rmSync(path.join(molioHome, 'skills', entry.id), { recursive: true, force: true });
    syncSkill(entry.id, slugifySkillName(entry.name), opts);

    assert.ok(!fs.existsSync(dest), 'stale mirror removed when the source is gone');
  });

  it('syncSkill keeps the mirror when the source is merely unreadable (EACCES)', (t) => {
    // Regression: existsSync reports false on EACCES too, so a transient NAS
    // permission blip used to delete a healthy, enabled skill's mirror out of
    // every vault. Only a proven ENOENT may trigger removal.
    if (process.platform === 'win32') {
      t.skip('chmod-based access denial is not reliable on Windows');
      return;
    }
    if (process.getuid?.() === 0) {
      t.skip('root bypasses permission bits');
      return;
    }
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    const dest = path.join(claudeHome, 'skills', molioDir('S'));
    assert.ok(fs.existsSync(dest), 'mirror created first');

    const libraryDir = path.join(molioHome, 'skills');
    fs.chmodSync(libraryDir, 0o000); // lstat of <library>/<id> now fails EACCES
    try {
      syncSkill(entry.id, slugifySkillName(entry.name), opts);
      assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'mirror kept on EACCES');
    } finally {
      fs.chmodSync(libraryDir, 0o755); // restore so afterEach cleanup works
    }
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
    reconcileSync(planSyncTargets([entry]), opts); // must not throw

    assert.ok(fs.existsSync(stray), 'non-directory entries are left alone');
    assert.ok(fs.existsSync(path.join(skillsDir, molioDir('S'), 'SKILL.md')));
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

  it('mirroring skips FIFOs instead of blocking on them', { timeout: 5000 }, (t) => {
    // copyFileSync opening a FIFO with no writer blocks forever — the daemon
    // used to freeze on startup fan-out and re-freeze on every restart.
    // POSIX-only: Windows has no mkfifo. The timeout turns a regression into
    // a failure instead of a hang.
    if (process.platform === 'win32') {
      t.skip('FIFOs do not exist on Windows');
      return;
    }
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-fifo-src-'));
    // dest MUST live outside src: copyDirSync walks src recursively, and a
    // dest inside src copies the mirror into itself until ENAMETOOLONG
    // (that is what the first version of this test did, and macOS CI proved it).
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-fifo-dest-'));
    try {
      fs.writeFileSync(path.join(src, 'SKILL.md'), 'body\n', 'utf8');
      const fifo = path.join(src, 'pipe');
      const res = spawnSync('mkfifo', [fifo]);
      if (res.status !== 0) {
        t.skip('mkfifo unavailable on this platform');
        return;
      }

      copyDirSync(src, dest);

      assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'regular files copied');
      assert.ok(!fs.existsSync(path.join(dest, 'pipe')), 'FIFO NOT copied');
      // hashDir skips non-regular files too, so parity (short-circuit) holds.
      assert.ok(isAlreadySynced(src, dest), 'hash parity holds despite the skipped FIFO');
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('reconcileSync with empty planned set removes all molio dirs but keeps user dirs', () => {
    const userDir = path.join(claudeHome, 'skills', 'keep-me');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'x', 'utf8');
    // Set up a synced molio dir explicitly (createSkill no longer auto-syncs).
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    syncSkill(entry.id, slugifySkillName(entry.name), opts);
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', molioDir('S'))));

    reconcileSync([], opts);

    assert.ok(!fs.existsSync(path.join(claudeHome, 'skills', molioDir('S'))));
    assert.ok(fs.existsSync(userDir), 'user dir survives');
  });

  it('reconcileSync skips the orphan sweep when any target failed to sync', () => {
    // Regression (PR #212 review): a rename changes the planned dirName, so a
    // failed sync of the NEW dir (the NAS EACCES/EBUSY class this module
    // degrades on) plus an unconditional sweep deleted the OLD dir too — the
    // vault was left with NO copy of the skill. A degraded pass must keep
    // everything and retry on the next clean reconcile.
    const skillsDir = path.join(claudeHome, 'skills');

    // The skill's last good copy under its OLD name — an "orphan" to the
    // planned set after the rename.
    const oldCopy = path.join(skillsDir, 'molio--old-name');
    fs.mkdirSync(oldCopy, { recursive: true });
    fs.writeFileSync(path.join(oldCopy, 'SKILL.md'), 'last good copy', 'utf8');

    // A genuine orphan (would be swept on a clean pass).
    const orphan = path.join(skillsDir, 'molio--orphan');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'SKILL.md'), 'stale', 'utf8');

    // Corrupt the library source — a FILE where a dir should be — so
    // syncSkill throws deterministically on every platform (lstat succeeds,
    // the mirror copy then hits ENOTDIR), emulating the failure class.
    const entry = createSkill(db, { name: 'S', description: '', enabled: true, builtIn: false }, 'body', opts);
    fs.rmSync(path.join(molioHome, 'skills', entry.id), { recursive: true, force: true });
    fs.writeFileSync(path.join(molioHome, 'skills', entry.id), 'corrupted — not a dir', 'utf8');

    reconcileSync(planSyncTargets([entry]), opts);

    assert.ok(fs.existsSync(path.join(oldCopy, 'SKILL.md')), 'old copy kept when the new-name sync failed');
    assert.ok(fs.existsSync(orphan), 'orphan sweep skipped on a degraded pass');
    assert.ok(!fs.existsSync(path.join(skillsDir, molioDir('S'))), 'failed target left no partial mirror');

    // Heal the source → the next pass converges: sync succeeds AND both the
    // old copy and the orphan are swept.
    fs.rmSync(path.join(molioHome, 'skills', entry.id), { force: true });
    fs.mkdirSync(path.join(molioHome, 'skills', entry.id), { recursive: true });
    fs.writeFileSync(path.join(molioHome, 'skills', entry.id, 'SKILL.md'), 'body', 'utf8');
    reconcileSync(planSyncTargets([entry]), opts);
    assert.ok(fs.existsSync(path.join(skillsDir, molioDir('S'), 'SKILL.md')), 'clean pass synced the skill');
    assert.ok(!fs.existsSync(oldCopy), 'clean pass swept the stale old-name copy');
    assert.ok(!fs.existsSync(orphan), 'clean pass swept the orphan');
  });

  it('reconcileSync sweeps legacy molio--<uuid> dirs left by older builds (upgrade migration)', () => {
    // Pre-name-based builds synced as molio--<uuid>. After the upgrade those
    // dirs are orphans to the name-based reconcile and must be removed while
    // the same skill's new readable dir is created — no migration code needed.
    const entry = createSkill(db, { name: 'Report', description: '', enabled: true, builtIn: false }, 'body', opts);
    const legacyDir = path.join(claudeHome, 'skills', `molio--${entry.id}`);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'SKILL.md'), 'old uuid-named copy', 'utf8');

    reconcileSync(planSyncTargets([entry]), opts);

    assert.ok(!fs.existsSync(legacyDir), 'legacy uuid-named dir removed');
    assert.ok(
      fs.existsSync(path.join(claudeHome, 'skills', molioDir('Report'), 'SKILL.md')),
      'readable name-based dir created',
    );
  });
});

describe('skills/sync: slugifySkillName (paths)', () => {
  it('keeps CJK + ASCII letters/digits, lowercases, maps the rest to single hyphens', () => {
    assert.equal(slugifySkillName('微信 Article 提取!'), '微信-article-提取');
    assert.equal(slugifySkillName('  --Foo  Bar-- '), 'foo-bar');
    assert.equal(slugifySkillName('C++ 编程'), 'c-编程');
  });

  it('NFKC-normalizes full-width characters', () => {
    assert.equal(slugifySkillName('ｖ２全角'), 'v2全角');
  });

  it('returns empty string when nothing slugifiable remains', () => {
    assert.equal(slugifySkillName('!!!'), '');
    assert.equal(slugifySkillName('🚀🚀'), '');
  });

  it('caps length at 64 code points without a trailing hyphen', () => {
    const slug = slugifySkillName('a'.repeat(100));
    assert.equal(Array.from(slug).length, 64);
    const capped = slugifySkillName('字'.repeat(70));
    assert.equal(Array.from(capped).length, 64);
    // a hyphen sitting exactly at the cut point must not survive
    const withHyphenAtCut = slugifySkillName(`${'a'.repeat(63)}!bbb`);
    assert.ok(!withHyphenAtCut.endsWith('-'));
    assert.ok(Array.from(withHyphenAtCut).length <= 64);
  });

  it('caps UTF-8 bytes for 4-byte astral characters (255-byte NAME_MAX safety)', () => {
    // Regression (PR #212 review): filesystems cap ONE path component at 255
    // BYTES, and CJK-Extension-B-style astral letters encode as 4 UTF-8 bytes
    // each — 64 of them are 256 bytes, ENAMETOOLONG before the `molio--`
    // prefix even counts. The code-point cap alone cannot catch this.
    const astral = '\u{20000}';
    const slug = slugifySkillName(astral.repeat(64));
    assert.ok(Array.from(slug).length > 0, 'astral letters are slugifiable');
    assert.ok(Array.from(slug).length < 64, 'byte cap kicks in below the code-point cap');
    assert.ok(Buffer.byteLength(slug, 'utf8') <= 200, `slug is ${Buffer.byteLength(slug, 'utf8')} bytes`);
    // The FULL synced dir name — prefix plus the longest collision suffix
    // planSyncTargets can append (`-<full uuid>-<id8>`) — must stay within one
    // 255-byte path component.
    const worstCase = `molio--${slug}-${'u'.repeat(36)}-${'x'.repeat(8)}`;
    assert.ok(Buffer.byteLength(worstCase, 'utf8') <= 255, worstCase);
  });

  it('output is always a safe path segment', () => {
    for (const name of ['../evil', 'a/b\\c', 'CON.', '  x  ', '技能: v1.0 <beta>']) {
      const slug = slugifySkillName(name);
      assert.ok(!slug.includes('/') && !slug.includes('\\'), `no separators in ${JSON.stringify(slug)}`);
      assert.ok(slug !== '.' && slug !== '..', `no dot segments in ${JSON.stringify(slug)}`);
    }
  });
});

describe('skills/sync: planSyncTargets (readable dir names + deterministic collisions)', () => {
  it('uses the slugified display name', () => {
    const targets = planSyncTargets([{ id: 'u-1', name: '周报生成', createdAt: 1 }]);
    assert.deepEqual(targets, [{ id: 'u-1', dirName: '周报生成' }]);
  });

  it('falls back to skill-<id prefix> when the slug is empty', () => {
    const targets = planSyncTargets([{ id: 'abcdef12-34', name: '🚀', createdAt: 1 }]);
    assert.deepEqual(targets, [{ id: 'abcdef12-34', dirName: 'skill-abcdef12' }]);
  });

  it('same-name skills get a stable id-derived suffix; earliest keeps the plain name', () => {
    const older = { id: '11111111-aaaa', name: '报告', createdAt: 100 };
    const newer = { id: '22222222-bbbb', name: '报告', createdAt: 200 };
    const targets = planSyncTargets([older, newer]);
    assert.deepEqual(targets, [
      { id: older.id, dirName: '报告' },
      { id: newer.id, dirName: '报告-22222222' },
    ]);
  });

  it('is deterministic regardless of input order (created_at drives assignment)', () => {
    const a = { id: '11111111-aaaa', name: '报告', createdAt: 100 };
    const b = { id: '22222222-bbbb', name: '报告', createdAt: 200 };
    assert.deepEqual(planSyncTargets([b, a]), planSyncTargets([a, b]));
  });

  it('distinct names that slugify identically also disambiguate', () => {
    const a = { id: '11111111-aaaa', name: 'Foo Bar', createdAt: 100 };
    const b = { id: '22222222-bbbb', name: 'foo--bar!', createdAt: 200 };
    const targets = planSyncTargets([a, b]);
    assert.deepEqual(new Set(targets.map((t) => t.dirName)).size, 2, 'no duplicate dir names');
    assert.equal(targets[0]?.dirName, 'foo-bar');
  });

  it('full-id fallback checks the taken set and escalates instead of colliding', () => {
    // Regression (PR #212 review): crafted/imported display names can occupy
    // BOTH fallback forms of a later skill. Unchecked, the full-id form was
    // assigned anyway — two skills sharing one dirName silently overwrite each
    // other's mirror. b's path here: base '报告' taken (a) → suffixed
    // '报告-22222222' taken (c) → full-id '报告-22222222-bbbb' taken (d) →
    // must escalate one more level.
    const c = { id: '33333333-cccc', name: '报告-22222222', createdAt: 50 };
    const a = { id: '11111111-aaaa', name: '报告', createdAt: 100 };
    const d = { id: '44444444-dddd', name: '报告-22222222-bbbb', createdAt: 150 };
    const b = { id: '22222222-bbbb', name: '报告', createdAt: 200 };

    const targets = planSyncTargets([b, d, a, c]);
    const names = targets.map((t) => t.dirName);
    assert.equal(new Set(names).size, 4, `dir names must be unique, got: ${names.join(', ')}`);
    assert.equal(targets.find((t) => t.id === b.id)?.dirName, '报告-22222222-bbbb-22222222');
  });

  it('planned dir names stay within the 255-byte NAME_MAX even for astral-character names', () => {
    const name = '\u{20000}'.repeat(64);
    const a = { id: '11111111-aaaa', name, createdAt: 1 };
    const b = { id: '22222222-bbbb', name, createdAt: 2 };
    for (const t of planSyncTargets([a, b])) {
      assert.ok(
        Buffer.byteLength(`molio--${t.dirName}`, 'utf8') <= 255,
        `molio--${t.dirName} exceeds NAME_MAX`,
      );
    }
  });
});
