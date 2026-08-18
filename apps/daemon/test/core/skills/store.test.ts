import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import {
  listSkills,
  createSkill,
  updateSkill,
  toggleSkill,
  deleteSkill,
  readInstructions,
  getSkill,
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
