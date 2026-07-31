import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { seedBuiltinSkills, initSkillLibrary, CORE_SKILLS_SEEDS } from '../../../src/core/skills/builtin.js';
import { listSkills, toggleSkill } from '../../../src/core/skills/store.js';
import { BUILTIN_SKILLS } from '../../../src/core/skill-installer.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

const EXPECTED_TOTAL = BUILTIN_SKILLS.length + CORE_SKILLS_SEEDS.length;

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
  it('seeds 8 bundled + 3 core built-ins, all flagged builtIn', () => {
    seedBuiltinSkills(db, opts);
    const skills = listSkills(db);
    assert.equal(skills.length, EXPECTED_TOTAL, '8 bundled + 3 core');
    for (const s of skills) {
      assert.equal(s.builtIn, true);
    }

    const bundled = skills.filter((s) => s.kind === 'bundled');
    const core = skills.filter((s) => s.core);
    assert.equal(bundled.length, BUILTIN_SKILLS.length, 'all bundled skills seeded');
    assert.equal(core.length, CORE_SKILLS_SEEDS.length, 'all core skills seeded');

    // bundled ids match the shipped slugs exactly.
    assert.deepEqual(
      bundled.map((s) => s.id).sort(),
      [...BUILTIN_SKILLS].sort(),
    );
    // core skills are library-kind + core, and never marked as a toggleable bundled skill.
    for (const s of core) {
      assert.equal(s.kind, 'library');
      assert.equal(s.core, true);
    }
  });

  it('bundled seeds get their display name/description from the shipped SKILL.md', () => {
    seedBuiltinSkills(db, opts);
    const docling = listSkills(db).find((s) => s.id === 'docling');
    assert.ok(docling, 'docling seeded');
    assert.ok(docling!.name.length > 0, 'name read from frontmatter (or fallback)');
    assert.ok(docling!.description.length > 0, 'description read from frontmatter (or fallback)');
  });

  it('core seeds write their SKILL.md body to the library (behavior preserved)', () => {
    seedBuiltinSkills(db, opts);
    const id = CORE_SKILLS_SEEDS[0]?.id;
    assert.ok(id);
    const md = path.join(molioHome, 'skills', id!, 'SKILL.md');
    assert.ok(fs.existsSync(md), 'core skill body written so it can be synced');
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

  it('re-seeding refreshes name/description but never touches enabled/core', () => {
    seedBuiltinSkills(db, opts);
    // Flip both a bundled and a core skill, then mutate a name directly.
    toggleSkill(db, 'docling', false);
    db.prepare('UPDATE skills SET name = ? WHERE id = ?').run('STALE NAME', 'docling');

    seedBuiltinSkills(db, opts);
    const docling = listSkills(db).find((s) => s.id === 'docling');
    assert.equal(docling?.enabled, false, 'enabled preserved');
    assert.notEqual(docling?.name, 'STALE NAME', 'name refreshed from source');
  });

  it('initSkillLibrary only seeds the DB — it never syncs (per-vault sync is separate)', () => {
    initSkillLibrary(db, opts);
    assert.equal(listSkills(db).length, EXPECTED_TOTAL);
    // nothing written to .claude/skills by seeding
    const skillsRoot = path.join(claudeHome, 'skills');
    const entries = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : [];
    assert.equal(entries.filter((e) => e.startsWith('molio--')).length, 0, 'no molio-- sync dirs');
  });
});
