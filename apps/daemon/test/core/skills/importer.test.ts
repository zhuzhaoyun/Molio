import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { importFromRaw, importFromFolder, SkillImportError } from '../../../src/core/skills/importer.js';
import { readInstructions } from '../../../src/core/skills/store.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-import-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-import-claude-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-import-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('skills/importer', () => {
  it('importFromRaw parses frontmatter + body', () => {
    const raw = ['---', 'name: 翻译润色', 'description: 翻译并润色', 'version: 1.0.0', '---', '', '保持原意翻译。'].join('\n');
    const entry = importFromRaw(db,raw, opts);
    assert.equal(entry.name, '翻译润色');
    assert.equal(entry.description, '翻译并润色');
    assert.equal(entry.builtIn, false);
    assert.equal(entry.enabled, true);
    assert.equal(readInstructions(entry.id, opts), '保持原意翻译。');
  });

  it('importFromRaw without frontmatter uses a default name and whole text as body', () => {
    const entry = importFromRaw(db,'just some instructions here', opts);
    assert.equal(entry.name, '导入的技能');
    assert.equal(readInstructions(entry.id, opts), 'just some instructions here');
  });

  it('importFromRaw rejects empty content', () => {
    assert.throws(() => importFromRaw(db,'   ', opts), (err: unknown) => {
      return err instanceof SkillImportError && err.code === 'BAD_REQUEST';
    });
  });

  it('importFromFolder reads <folder>/SKILL.md and falls back to folder name', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-src-'));
    try {
      fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\ndescription: d\n---\n\nbody here\n', 'utf8');
      const entry = importFromFolder(db,folder, opts);
      assert.equal(entry.name, path.basename(folder), 'name falls back to folder basename');
      assert.equal(entry.description, 'd');
      assert.equal(readInstructions(entry.id, opts), 'body here');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('importFromFolder throws NOT_FOUND when SKILL.md missing', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-empty-'));
    try {
      assert.throws(() => importFromFolder(db,folder, opts), (err: unknown) => {
        return err instanceof SkillImportError && err.code === 'NOT_FOUND';
      });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
