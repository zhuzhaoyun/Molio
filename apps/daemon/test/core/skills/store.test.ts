import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import {
  listSkills,
  createSkill,
  updateSkill,
  toggleSkill,
  deleteSkill,
  readInstructions,
  getSkill,
  updateCustomInstructions,
  SkillNotFoundError,
} from '../../../src/core/skills/store.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-store-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-store-claude-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-store-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('skills/store', () => {
  it('listSkills is empty for a fresh database', () => {
    assert.deepEqual(listSkills(db), []);
  });

  it('createSkill writes SKILL.md with frontmatter + body and records a DB row', () => {
    const entry = createSkill(
      db,
      { name: '写文章', description: '写一篇文章', enabled: false, builtIn: false },
      '先列大纲再展开。',
      opts,
    );
    assert.ok(entry.id, 'should assign an id');
    assert.equal(entry.builtIn, false);
    assert.equal(entry.kind, 'library', 'defaults to library');

    const md = fs.readFileSync(path.join(molioHome, 'skills', entry.id, 'SKILL.md'), 'utf8');
    assert.ok(md.startsWith('---\n'), 'starts with frontmatter fence');
    assert.match(md, /^name: 写文章$/m);
    assert.match(md, /^description: 写一篇文章$/m);
    assert.match(md, /^version: 1\.0\.0$/m);
    assert.ok(md.includes('先列大纲再展开。'), 'body present');

    const rows = listSkills(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, entry.id);
    assert.equal(rows[0]?.enabled, false, 'enabled flag persisted');
  });

  it('createSkill uses provided id for built-ins', () => {
    const entry = createSkill(
      db,
      { id: 'my-builtin', name: 'X', description: '', enabled: false, builtIn: true },
      'body',
      opts,
    );
    assert.equal(entry.id, 'my-builtin');
    assert.equal(getSkill(db, 'my-builtin')?.builtIn, true);
  });

  it('createSkill with kind=bundled writes NO content dir (content ships with the app)', () => {
    const entry = createSkill(
      db,
      { id: 'docling', name: 'docling', description: '', enabled: true, builtIn: true, kind: 'bundled' },
      '',
      opts,
    );
    assert.equal(entry.kind, 'bundled');
    assert.ok(!fs.existsSync(path.join(molioHome, 'skills', entry.id)), 'no library content dir for bundled');
    assert.equal(getSkill(db, 'docling')?.kind, 'bundled');
  });

  // store.ts is pure catalog CRUD — it never writes to .claude/skills.
  // Per-vault sync lives in vault-config.ts (see vault-config.test.ts).
  it('createSkill does NOT sync anywhere (sync moved to vault-config)', () => {
    const entry = createSkill(
      db,
      { name: 'S', description: '', enabled: true, builtIn: false },
      'body',
      opts,
    );
    const skillsRoot = path.join(claudeHome, 'skills');
    const molioDirs = fs.existsSync(skillsRoot)
      ? fs.readdirSync(skillsRoot).filter((n) => n.startsWith('molio--'))
      : [];
    assert.deepEqual(molioDirs, [], 'store must not write to .claude/skills');
  });

  it('updateSkill rewrites frontmatter (name) and keeps instructions', () => {
    const entry = createSkill(
      db,
      { name: 'Old', description: 'd', enabled: true, builtIn: false },
      'KEEP-ME',
      opts,
    );
    updateSkill(db, entry.id, { name: 'New' }, opts);

    assert.equal(readInstructions(entry.id, opts), 'KEEP-ME');
    const md = fs.readFileSync(path.join(molioHome, 'skills', entry.id, 'SKILL.md'), 'utf8');
    assert.match(md, /^name: New$/m);
    assert.equal(getSkill(db, entry.id)?.name, 'New', 'name persisted to DB');
  });

  it('updateSkill changes instructions body', () => {
    const entry = createSkill(
      db,
      { name: 'S', description: '', enabled: false, builtIn: false },
      'old body',
      opts,
    );
    updateSkill(db, entry.id, { instructions: 'new body' }, opts);
    assert.equal(readInstructions(entry.id, opts), 'new body');
  });

  it('updateSkill on unknown id throws SkillNotFoundError', () => {
    assert.throws(() => updateSkill(db, 'nope', { name: 'x' }, opts), SkillNotFoundError);
  });

  it('toggleSkill flips the DB enabled flag (no sync side effects)', () => {
    const entry = createSkill(
      db,
      { name: 'S', description: '', enabled: true, builtIn: false },
      'body',
      opts,
    );
    toggleSkill(db, entry.id, false);
    assert.equal(getSkill(db, entry.id)?.enabled, false);

    toggleSkill(db, entry.id, true);
    assert.equal(getSkill(db, entry.id)?.enabled, true);
    // store never writes to .claude/skills
    const skillsRoot = path.join(claudeHome, 'skills');
    const molioDirs = fs.existsSync(skillsRoot)
      ? fs.readdirSync(skillsRoot).filter((n) => n.startsWith('molio--'))
      : [];
    assert.deepEqual(molioDirs, [], 'store must not write to .claude/skills');
  });

  it('deleteSkill removes content dir and DB row', () => {
    const entry = createSkill(
      db,
      { name: 'S', description: '', enabled: true, builtIn: false },
      'body',
      opts,
    );
    deleteSkill(db, entry.id, opts);
    assert.ok(!fs.existsSync(path.join(molioHome, 'skills', entry.id)));
    assert.equal(listSkills(db).length, 0);
  });

  it('deleteSkill on unknown id is a no-op', () => {
    assert.doesNotThrow(() => deleteSkill(db, 'nope', opts));
  });

  it('readInstructions degrades to "" for traversal/invalid ids instead of throwing', () => {
    // Regression: skill ids are interpolated into paths; a bad id (route param,
    // corrupted DB row) made skillContentDir throw INSIDE readInstructions and
    // the GET /:id route 500'd. The guard throws, readInstructions catches → ''.
    assert.equal(readInstructions('../..', opts), '');
    assert.equal(readInstructions('..\\skills', opts), '');
    assert.equal(readInstructions('', opts), '');
    assert.equal(readInstructions('a/b', opts), '');
  });
});

describe('skills/store customInstructions (overlay)', () => {
  it('updateCustomInstructions persists the overlay and getSkill returns it', () => {
    const entry = createSkill(
      db,
      { name: '写文章', description: '写一篇文章', enabled: true, builtIn: false },
      '先列大纲再展开。',
      opts,
    );
    const overlay = '输出一律用简体中文。\n题干末尾附答题卡。';
    const updated = updateCustomInstructions(db, entry.id, overlay);
    assert.equal(updated.customInstructions, overlay);
    assert.equal(getSkill(db, entry.id)?.customInstructions, overlay);
  });

  it('updateCustomInstructions(null) clears the overlay', () => {
    const entry = createSkill(
      db,
      { name: '总结', description: 'd', enabled: true, builtIn: false },
      'body',
      opts,
    );
    updateCustomInstructions(db, entry.id, '临时要求');
    const cleared = updateCustomInstructions(db, entry.id, null);
    assert.equal(cleared.customInstructions, undefined);
    assert.equal(getSkill(db, entry.id)?.customInstructions, undefined);
  });

  it('updateCustomInstructions throws SkillNotFoundError for an unknown id', () => {
    assert.throws(() => updateCustomInstructions(db, 'no-such-skill', 'x'), SkillNotFoundError);
  });

  it('a legacy skills table without custom_instructions is migrated on open and old rows stay readable', () => {
    closeDatabase();
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-store-legacy-'));
    const raw = new Database(path.join(legacyDir, 'app.sqlite'));
    // Pre-overlay schema: exactly the columns shipped before this feature.
    raw.exec(`
      CREATE TABLE skills (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL DEFAULT 'library',
        core        INTEGER NOT NULL DEFAULT 0,
        built_in    INTEGER NOT NULL DEFAULT 0,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    raw.prepare(
      `INSERT INTO skills (id, name, description, kind, core, built_in, enabled, created_at, updated_at)
       VALUES ('legacy-1', '旧技能', 'd', 'library', 0, 0, 1, ?, ?)`,
    ).run(now, now);
    raw.close();

    // openDatabase runs migrate() → addColumnIfMissing must add the column.
    db = openDatabase(legacyDir);
    const rows = db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>;
    assert.ok(rows.some((r) => r.name === 'custom_instructions'), 'migration must add custom_instructions');
    assert.equal(listSkills(db).length, 1);
    assert.equal(getSkill(db, 'legacy-1')?.customInstructions, undefined);
    // And the migrated row accepts an overlay write.
    const updated = updateCustomInstructions(db, 'legacy-1', '迁移后可写');
    assert.equal(updated.customInstructions, '迁移后可写');
    db = openDatabase(dbDir); // restore the beforeEach db for afterEach cleanup shape
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });
});
