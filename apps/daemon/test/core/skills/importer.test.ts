import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import {
  importFromRaw,
  importFromFolder,
  SkillImportError,
  MAX_IMPORT_BYTES,
} from '../../../src/core/skills/importer.js';
import { readInstructions } from '../../../src/core/skills/store.js';
import { skillContentDir, type SkillPathsOpts } from '../../../src/core/skills/paths.js';

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

/** Count skill content dirs under the temp library (`~/.molio/skills/<id>`). */
function listContentDirs(): number {
  const root = path.join(molioHome, 'skills');
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

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

  it('importFromRaw derives the name from the first heading when frontmatter lacks one', () => {
    const entry = importFromRaw(db, '# 周报助手\n\n按以下步骤生成周报……', opts);
    assert.equal(entry.name, '周报助手');
    assert.equal(readInstructions(entry.id, opts), '# 周报助手\n\n按以下步骤生成周报……');
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

  it('importFromFolder accepts a direct .md file path (not a folder)', () => {
    // Regression: pasting a file path like `.../SKILL (1).md` must NOT have
    // `\SKILL.md` appended to it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-file-'));
    const file = path.join(dir, 'SKILL (1).md');
    try {
      fs.writeFileSync(file, '---\nname: 直接文件\ndescription: df\n---\n\nfile body\n', 'utf8');
      const entry = importFromFolder(db, file, opts);
      assert.equal(entry.name, '直接文件');
      assert.equal(entry.description, 'df');
      assert.equal(readInstructions(entry.id, opts), 'file body');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('importFromFolder reads the name field of an unfenced .md file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-unfenced-'));
    const file = path.join(dir, 'khazix-writer.md');
    try {
      fs.writeFileSync(
        file,
        'name: khazix-writer\ndescription: |\n  公众号长文写作skill。\n\n写作步骤……\n',
        'utf8',
      );
      const entry = importFromFolder(db, file, opts);
      assert.equal(entry.name, 'khazix-writer');
      assert.equal(entry.description, '公众号长文写作skill。');
      assert.equal(readInstructions(entry.id, opts), '写作步骤……');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('importFromFolder falls back to the file basename (sans .md) when no frontmatter name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-file2-'));
    const file = path.join(dir, 'My Cool Skill.md');
    try {
      fs.writeFileSync(file, 'no frontmatter, just body\n', 'utf8');
      const entry = importFromFolder(db, file, opts);
      assert.equal(entry.name, 'My Cool Skill');
      assert.equal(readInstructions(entry.id, opts), 'no frontmatter, just body');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('importFromRaw parses an unfenced field block (platform paste without ---)', () => {
    // Regression: pasted content that lost its `---` fences used to import with
    // the first-10-chars junk name "name: khaz" instead of the real name field.
    const raw = 'name: khazix-writer\ndescription: |\n  数字生命卡兹克的写作skill。\n\n正文内容';
    const entry = importFromRaw(db, raw, opts);
    assert.equal(entry.name, 'khazix-writer');
    assert.equal(entry.description, '数字生命卡兹克的写作skill。');
    assert.equal(readInstructions(entry.id, opts), '正文内容');
  });

  it('importFromFolder reports the file path itself when a .md path does not exist', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-here-SKILL (1).md');
    assert.throws(() => importFromFolder(db, missing, opts), (err: unknown) => {
      return (
        err instanceof SkillImportError &&
        err.code === 'NOT_FOUND' &&
        err.message.includes(missing) &&
        !err.message.includes(path.join(missing, 'SKILL.md'))
      );
    });
  });

  it('importFromFolder copies a whole multi-file directory (SKILL.md + siblings)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-multi-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: 多文件\ndescription: multi\n---\n\n见 references/guide.md\n',
        'utf8',
      );
      fs.mkdirSync(path.join(dir, 'references'));
      fs.writeFileSync(path.join(dir, 'references', 'guide.md'), 'detailed guide\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'run.py'), 'print("hi")\n', 'utf8');

      const entry = importFromFolder(db, dir, opts);
      assert.equal(entry.name, '多文件');
      assert.equal(readInstructions(entry.id, opts), '见 references/guide.md');

      // Siblings must be copied verbatim into the skill content dir.
      const contentDir = skillContentDir(entry.id, opts);
      assert.ok(fs.existsSync(path.join(contentDir, 'references', 'guide.md')), 'nested sibling copied');
      assert.equal(
        fs.readFileSync(path.join(contentDir, 'references', 'guide.md'), 'utf8'),
        'detailed guide\n',
      );
      assert.ok(fs.existsSync(path.join(contentDir, 'run.py')), 'root sibling copied');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('importFromFolder rejects a folder exceeding the byte limit (BAD_REQUEST)', () => {
    // A sparse file reports its full size to stat without occupying disk, so we
    // can trip the byte limit cheaply.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-big-'));
    try {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Big\n---\n\nbody\n', 'utf8');
      const big = path.join(dir, 'model.bin');
      fs.writeFileSync(big, '', 'utf8');
      fs.truncateSync(big, MAX_IMPORT_BYTES + 1);

      assert.throws(() => importFromFolder(db, dir, opts), (err: unknown) => {
        return (
          err instanceof SkillImportError &&
          err.code === 'BAD_REQUEST' &&
          err.message.includes('超过上限')
        );
      });
      // And nothing was written into the library on failure.
      assert.equal(listContentDirs(), 0, 'no partial skill dir left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('importFromFolder throws NOT_FOUND for a directory without a root SKILL.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-noskillmd-'));
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), 'no skill here\n', 'utf8');
      assert.throws(() => importFromFolder(db, dir, opts), (err: unknown) => {
        return err instanceof SkillImportError && err.code === 'NOT_FOUND';
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
