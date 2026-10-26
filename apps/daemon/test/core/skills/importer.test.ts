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
  inspectSkillSource,
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

  it('importFromFolder rejects a single oversized .md file BEFORE reading it', () => {
    // Regression: the direct-file path used to readFileSync first and check the
    // size afterwards — a multi-GB paste would explode daemon memory before the
    // limit could reject it. stat must gate the read. A sparse file reports its
    // full size to stat without occupying disk, tripping the limit cheaply.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-bigfile-'));
    const file = path.join(dir, 'huge.md');
    try {
      fs.writeFileSync(file, '', 'utf8');
      fs.truncateSync(file, MAX_IMPORT_BYTES + 1);
      assert.throws(() => importFromFolder(db, file, opts), (err: unknown) => {
        return (
          err instanceof SkillImportError &&
          err.code === 'BAD_REQUEST' &&
          err.message.includes('超过上限')
        );
      });
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

describe('skills/importer inspectSkillSource', () => {
  it('dir with SKILL.md → ok preview, frontmatter name, sibling file list', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-inspect-'));
    try {
      fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: 检查员\ndescription: d\n---\n\nbody\n', 'utf8');
      fs.mkdirSync(path.join(folder, 'references'));
      fs.writeFileSync(path.join(folder, 'references', 'guide.md'), 'g\n', 'utf8');
      const r = inspectSkillSource({ folderPath: folder });
      assert.equal(r.ok, true);
      assert.equal(r.name, '检查员');
      assert.equal(r.nameFallback, false);
      assert.equal(r.entryFile, 'SKILL.md');
      assert.deepEqual(r.files.map((f) => f.path), ['SKILL.md', 'references/guide.md']);
      assert.deepEqual(r.issues, []);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('dir without SKILL.md → NO_ENTRY error, ok=false', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-inspect-empty-'));
    try {
      const r = inspectSkillSource({ folderPath: folder });
      assert.equal(r.ok, false);
      assert.equal(r.entry, null);
      assert.equal(r.issues[0]?.code, 'NO_ENTRY');
      assert.equal(r.issues[0]?.level, 'error');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('missing path → SOURCE_UNREADABLE (also for a backslash path on this OS)', () => {
    const r = inspectSkillSource({ folderPath: path.join(os.tmpdir(), 'molio-nope-does-not-exist') });
    assert.equal(r.ok, false);
    assert.equal(r.issues[0]?.code, 'SOURCE_UNREADABLE');
    // Windows-style separators on a POSIX host: stat fails → same clean issue, never a throw.
    const r2 = inspectSkillSource({ folderPath: 'D:\\skills\\不存在' });
    assert.equal(r2.ok, false);
    assert.equal(r2.issues[0]?.code, 'SOURCE_UNREADABLE');
  });

  it('frontmatter without name → NAME_FALLBACK warning + basename name; no description → DESCRIPTION_FALLBACK', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-inspect-fb-'));
    try {
      fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\ndescription: \n---\n\nbody\n', 'utf8');
      const r = inspectSkillSource({ folderPath: folder });
      assert.equal(r.ok, true);
      assert.equal(r.name, path.basename(folder));
      assert.equal(r.nameFallback, true);
      assert.equal(r.descriptionFallback, true);
      const codes = r.issues.map((i) => i.code);
      assert.ok(codes.includes('NAME_FALLBACK'));
      assert.ok(codes.includes('DESCRIPTION_FALLBACK'));
      assert.ok(r.issues.every((i) => i.level === 'warning'));
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('single .md file → one-file list, entryFile = basename', () => {
    const file = path.join(os.tmpdir(), `molio-skill-inspect-single-${Date.now()}.md`);
    try {
      fs.writeFileSync(file, '---\nname: 单文件\ndescription: d\n---\n\nbody\n', 'utf8');
      const r = inspectSkillSource({ folderPath: file });
      assert.equal(r.ok, true);
      assert.equal(r.entryFile, path.basename(file));
      assert.equal(r.files.length, 1);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('single .MD file (uppercase extension) is still a valid single-file skill', () => {
    const file = path.join(os.tmpdir(), `molio-skill-inspect-upper-${Date.now()}.MD`);
    try {
      fs.writeFileSync(file, '---\nname: 大写扩展\ndescription: d\n---\n\nbody\n', 'utf8');
      const r = inspectSkillSource({ folderPath: file });
      assert.equal(r.ok, true);
      assert.equal(r.entryFile, path.basename(file));
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('single non-.md file (e.g. a .rar archive) → UNSUPPORTED_TYPE error, never a fake "single-file skill"', () => {
    // Regression (real-machine): dragging a .rar onto the dropzone used to be
    // accepted as a "single-file skill" — the binary junk parsed as instructions
    // and the preview showed a green verdict. Spec §5.3: only a single .md is a
    // valid file source; anything else must be rejected with a human-readable
    // error (archives: extract first).
    const file = path.join(os.tmpdir(), `molio-skill-inspect-rar-${Date.now()}.rar`);
    try {
      fs.writeFileSync(file, '---\nname: 压缩包\ndescription: d\n---\n\nbody\n', 'utf8');
      const r = inspectSkillSource({ folderPath: file });
      assert.equal(r.ok, false);
      assert.equal(r.entry, null);
      assert.equal(r.issues[0]?.code, 'UNSUPPORTED_TYPE');
      assert.equal(r.issues[0]?.level, 'error');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('raw without instructions → EMPTY_BODY', () => {
    const r = inspectSkillSource({ raw: '---\nname: x\n---\n\n   ' });
    assert.equal(r.ok, false);
    assert.equal(r.issues[0]?.code, 'EMPTY_BODY');
  });

  it('folder over the file-count limit → TOO_MANY_FILES error + truncated', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-inspect-many-'));
    try {
      fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: 大\ndescription: d\n---\n\nbody\n', 'utf8');
      for (let i = 0; i <= 1000; i++) {
        fs.writeFileSync(path.join(folder, `f${i}.txt`), 'x', 'utf8');
      }
      const r = inspectSkillSource({ folderPath: folder });
      assert.equal(r.ok, false);
      assert.equal(r.truncated, true);
      assert.equal(r.issues[0]?.code, 'TOO_MANY_FILES');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('overrides flow through importFromFolder (name/description win over parsed values)', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-inspect-ovr-'));
    try {
      fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: 原名\ndescription: 原描述\n---\n\nbody\n', 'utf8');
      const entry = importFromFolder(db, folder, opts, { name: '改过的名', description: '改过的描述' });
      assert.equal(entry.name, '改过的名');
      assert.equal(entry.description, '改过的描述');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
