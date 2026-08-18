import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import {
  seedBuiltinSkills,
  initSkillLibrary,
  readBundledInstructions,
  RETIRED_CORE_SKILLS,
} from '../../../src/core/skills/builtin.js';
import { listSkills, toggleSkill } from '../../../src/core/skills/store.js';
import { BUILTIN_SKILLS } from '../../../src/core/skill-installer.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

const EXPECTED_TOTAL = BUILTIN_SKILLS.length;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-builtin-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-builtin-claude-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-builtin-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('skills/builtin', () => {
  it('seeds only the bundled built-ins, all flagged builtIn', () => {
    seedBuiltinSkills(db, opts);
    const skills = listSkills(db);
    assert.equal(skills.length, EXPECTED_TOTAL, 'bundled only (the core writing trio was removed)');
    for (const s of skills) {
      assert.equal(s.builtIn, true);
    }

    const bundled = skills.filter((s) => s.kind === 'bundled');
    assert.equal(bundled.length, BUILTIN_SKILLS.length, 'all bundled skills seeded');

    // bundled ids match the shipped slugs exactly.
    assert.deepEqual(
      bundled.map((s) => s.id).sort(),
      [...BUILTIN_SKILLS].sort(),
    );
  });

  it('bundled seeds get their display name/description from the shipped SKILL.md', () => {
    seedBuiltinSkills(db, opts);
    const docling = listSkills(db).find((s) => s.id === 'docling');
    assert.ok(docling, 'docling seeded');
    assert.ok(docling!.name.length > 0, 'name read from frontmatter (or fallback)');
    assert.ok(docling!.description.length > 0, 'description read from frontmatter (or fallback)');
  });

  it('bundled seeds write NO library content dir (content ships with the app)', () => {
    seedBuiltinSkills(db, opts);
    for (const slug of BUILTIN_SKILLS) {
      assert.ok(!fs.existsSync(path.join(molioHome, 'skills', slug)), `no library dir for ${slug}`);
    }
  });

  it('seeding is idempotent — second call does not duplicate', () => {
    seedBuiltinSkills(db, opts);
    seedBuiltinSkills(db, opts);
    assert.equal(listSkills(db).length, EXPECTED_TOTAL);
  });

  it('upgrade migration: deletes a legacy bundled remotion row, never a same-id user skill', () => {
    // Phase 1 — DB left behind by an older version that still seeded remotion
    // as a bundled skill. The startup delete must retire the row.
    const now = Date.now();
    db.prepare(
      `INSERT INTO skills (id, name, description, kind, core, built_in, enabled, created_at, updated_at)
       VALUES ('remotion', 'remotion', 'legacy bundled row', 'bundled', 0, 1, 1, ?, ?)`,
    ).run(now, now);

    seedBuiltinSkills(db, opts);
    assert.ok(
      !listSkills(db).some((s) => s.id === 'remotion'),
      'the retired bundled row must be deleted on upgrade',
    );
    assert.equal(listSkills(db).length, EXPECTED_TOTAL);

    // Phase 2 — the user later installs a library skill with the same id (e.g.
    // the hub's am-will/remotion). The kind='bundled' guard must protect it
    // from the still-running idempotent delete.
    db.prepare(
      `INSERT INTO skills (id, name, description, kind, core, built_in, enabled, created_at, updated_at)
       VALUES ('remotion', 'remotion', 'user library skill', 'library', 0, 0, 1, ?, ?)`,
    ).run(now, now);

    seedBuiltinSkills(db, opts);
    const remotion = listSkills(db).find((s) => s.id === 'remotion');
    assert.ok(remotion, 'a user library skill with the retired id must survive re-seeding');
    assert.equal(remotion!.kind, 'library');
  });

  it('upgrade migration: retires the removed core writing trio (rows + content dirs), never a same-id user skill', () => {
    // Phase 1 — DB + library left behind by an older version that seeded the
    // core writing trio. The startup retirement must delete every retired row
    // (guarded on core=1) AND remove the library content dirs.
    const now = Date.now();
    for (const id of RETIRED_CORE_SKILLS) {
      db.prepare(
        `INSERT INTO skills (id, name, description, kind, core, built_in, enabled, created_at, updated_at)
         VALUES (?, ?, 'legacy core row', 'library', 1, 1, 1, ?, ?)`,
      ).run(id, id, now, now);
      const dir = path.join(molioHome, 'skills', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), 'legacy core body');
    }

    seedBuiltinSkills(db, opts);
    const skills = listSkills(db);
    for (const id of RETIRED_CORE_SKILLS) {
      assert.ok(!skills.some((s) => s.id === id), `retired core row ${id} must be deleted on upgrade`);
      assert.ok(
        !fs.existsSync(path.join(molioHome, 'skills', id)),
        `library content dir of ${id} must be removed on upgrade`,
      );
    }
    assert.equal(skills.length, EXPECTED_TOTAL);

    // Phase 2 — the user later creates a library skill with a coincidentally
    // identical id (core=0). The core=1 guard must protect it from the
    // still-running idempotent retirement delete.
    db.prepare(
      `INSERT INTO skills (id, name, description, kind, core, built_in, enabled, created_at, updated_at)
       VALUES ('summarize', 'summarize', 'user library skill', 'library', 0, 0, 1, ?, ?)`,
    ).run(now, now);
    const userDir = path.join(molioHome, 'skills', 'summarize');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), 'user body');

    seedBuiltinSkills(db, opts);
    const user = listSkills(db).find((s) => s.id === 'summarize');
    assert.ok(user, 'a user library skill with a retired id must survive re-seeding');
    assert.equal(user!.builtIn, false);
    assert.ok(fs.existsSync(path.join(userDir, 'SKILL.md')), 'user content dir must survive');
  });

  it('seeding preserves the user toggle state of an existing skill', () => {
    seedBuiltinSkills(db, opts);
    const id = BUILTIN_SKILLS[0];
    assert.ok(id);
    toggleSkill(db, id!, false); // user disables a bundled skill

    seedBuiltinSkills(db, opts); // re-seed (e.g. on restart)
    const entry = listSkills(db).find((s) => s.id === id);
    assert.equal(entry?.enabled, false, 'user toggle must be preserved');
    assert.equal(listSkills(db).length, EXPECTED_TOTAL);
  });

  it('re-seeding refreshes name/description but never touches enabled', () => {
    seedBuiltinSkills(db, opts);
    // Flip a bundled skill's switch, then mutate its name directly.
    toggleSkill(db, 'docling', false);
    db.prepare('UPDATE skills SET name = ? WHERE id = ?').run('STALE NAME', 'docling');

    seedBuiltinSkills(db, opts);
    const docling = listSkills(db).find((s) => s.id === 'docling');
    assert.equal(docling?.enabled, false, 'enabled preserved');
    assert.notEqual(docling?.name, 'STALE NAME', 'name refreshed from source');
  });

  it('initSkillLibrary only seeds the DB — it never syncs (per-vault sync is separate)', () => {
    assert.equal(initSkillLibrary(db, opts), true, 'returns true on success');
    assert.equal(listSkills(db).length, EXPECTED_TOTAL);
    // nothing written to .claude/skills by seeding
    const skillsRoot = path.join(claudeHome, 'skills');
    const entries = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : [];
    assert.equal(entries.filter((e) => e.startsWith('molio--')).length, 0, 'no molio-- sync dirs');
  });

  it('re-seeding does not bump updated_at when metadata is unchanged', () => {
    seedBuiltinSkills(db, opts);
    const first = listSkills(db).find((s) => s.id === 'docling');
    assert.ok(first);
    const stamp = first!.updatedAt;

    seedBuiltinSkills(db, opts); // identical metadata → conditional UPDATE is a no-op
    const second = listSkills(db).find((s) => s.id === 'docling');
    assert.equal(second?.updatedAt, stamp, 'updated_at must not churn when nothing changed');
  });

  it('readBundledInstructions returns the shipped SKILL.md body for a bundled slug', () => {
    // Build a fake shipped-skills tree so the test doesn't depend on repo layout.
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-bundled-src-'));
    try {
      fs.mkdirSync(path.join(sourceDir, 'fake-skill'));
      fs.writeFileSync(
        path.join(sourceDir, 'fake-skill', 'SKILL.md'),
        '---\nname: Fake\ndescription: d\nversion: 1.0.0\n---\n\nthe shipped body\n',
        'utf8',
      );

      assert.equal(
        readBundledInstructions('fake-skill', sourceDir),
        'the shipped body',
        'bundled duplicate prefill must read the shipped body',
      );
      assert.equal(readBundledInstructions('missing-skill', sourceDir), '', 'unknown slug → empty');
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
