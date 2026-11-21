import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { createSkill, updateCustomInstructions } from '../../../src/core/skills/store.js';
import { planSyncTargets, reconcileSync } from '../../../src/core/skills/sync.js';
import { listQuarantineEvents } from '../../../src/core/skills/quarantine.js';
import { USER_CUSTOM_BEGIN } from '../../../src/core/skills/compose.js';
import { __setMirrorStateDepsForTest } from '../../../src/core/skills/mirror-state.js';
import { slugifySkillName, type SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-sync-ov-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-sync-ov-claude-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-sync-ov-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  __setMirrorStateDepsForTest(null);
  closeDatabase();
  for (const d of [molioHome, claudeHome, dbDir]) fs.rmSync(d, { recursive: true, force: true });
});

const skillsDir = (): string => path.join(claudeHome, 'skills');
const mirrorMd = (name: string): string =>
  fs.readFileSync(path.join(skillsDir(), `molio--${slugifySkillName(name)}`, 'SKILL.md'), 'utf8');
const events = (): { source: string }[] => listQuarantineEvents(db, { unackedOnly: true });

describe('skills/sync × overlay + guard', () => {
  it('syncs a library skill with its overlay into molio--<dirName>/', () => {
    const entry = createSkill(db, { name: '带定制', description: '', enabled: true, builtIn: false }, '正文', opts);
    updateCustomInstructions(db, entry.id, '输出带引用');
    const [target] = planSyncTargets([
      { id: entry.id, name: '带定制', createdAt: entry.createdAt, customInstructions: '输出带引用' },
    ]);
    reconcileSync([target!], { ...opts, db });
    const md = mirrorMd('带定制');
    assert.ok(md.includes('正文'));
    assert.ok(md.includes(USER_CUSTOM_BEGIN));
    assert.ok(md.includes('输出带引用'));
  });

  it('hand-edited mirror: quarantined + vault-drift event, then rebuilt composed', () => {
    const entry = createSkill(db, { name: '漂移', description: '', enabled: true, builtIn: false }, '原文', opts);
    const targets = planSyncTargets([{ id: entry.id, name: '漂移', createdAt: entry.createdAt }]);
    reconcileSync(targets, { ...opts, db }); // establishes baseline
    const mdPath = path.join(skillsDir(), `molio--${slugifySkillName('漂移')}`, 'SKILL.md');
    fs.writeFileSync(mdPath, '用户手改的内容', 'utf8');
    reconcileSync(targets, { ...opts, db });
    const evs = events();
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.source, 'vault-drift');
    const qPath = listQuarantineEvents(db)[0]!.quarantinedPath;
    assert.equal(fs.readFileSync(path.join(qPath, 'SKILL.md'), 'utf8'), '用户手改的内容');
    const rebuilt = fs.readFileSync(mdPath, 'utf8');
    assert.ok(rebuilt.includes('原文'), 'rebuilt from the library SKILL.md');
    assert.ok(!rebuilt.includes('用户手改'), 'user edits do not survive the rebuild');
  });

  it('orphan sweep: hand-edited orphan is quarantined + ledgered, then removed', () => {
    const entry = createSkill(db, { name: '孤儿', description: '', enabled: true, builtIn: false }, '原文', opts);
    const targets = planSyncTargets([{ id: entry.id, name: '孤儿', createdAt: entry.createdAt }]);
    reconcileSync(targets, { ...opts, db }); // baseline established
    const orphanDir = path.join(skillsDir(), `molio--${slugifySkillName('孤儿')}`);
    fs.writeFileSync(path.join(orphanDir, 'SKILL.md'), '手改后技能被停用', 'utf8');
    reconcileSync([], { ...opts, db }); // skill gone from planned set → orphan
    assert.equal(events().length, 1);
    assert.equal(events()[0]!.source, 'orphan-sweep');
    const qPath = listQuarantineEvents(db)[0]!.quarantinedPath;
    assert.equal(fs.readFileSync(path.join(qPath, 'SKILL.md'), 'utf8'), '手改后技能被停用');
    assert.equal(fs.existsSync(orphanDir), false, 'orphan removed after backup');
  });

  it('orphan sweep: provably pristine orphan is removed silently (no event)', () => {
    const entry = createSkill(db, { name: '干净孤儿', description: '', enabled: true, builtIn: false }, '原文', opts);
    const targets = planSyncTargets([{ id: entry.id, name: '干净孤儿', createdAt: entry.createdAt }]);
    reconcileSync(targets, { ...opts, db });
    const orphanDir = path.join(skillsDir(), `molio--${slugifySkillName('干净孤儿')}`);
    reconcileSync([], { ...opts, db }); // pristine (== baseline) → rm without quarantine
    assert.equal(fs.existsSync(orphanDir), false);
    assert.equal(events().length, 0, 'pristine orphan removal is not an event');
  });

  it('orphan sweep: when the quarantine copy FAILS the dir is kept, never destroyed', () => {
    const entry = createSkill(db, { name: '保命', description: '', enabled: true, builtIn: false }, '原文', opts);
    const targets = planSyncTargets([{ id: entry.id, name: '保命', createdAt: entry.createdAt }]);
    reconcileSync(targets, { ...opts, db });
    const orphanDir = path.join(skillsDir(), `molio--${slugifySkillName('保命')}`);
    fs.writeFileSync(path.join(orphanDir, 'SKILL.md'), '不可销毁的用户内容', 'utf8');
    __setMirrorStateDepsForTest({ quarantineDir: () => null }); // backup fails
    reconcileSync([], { ...opts, db });
    assert.equal(fs.existsSync(orphanDir), true, 'dir kept when backup fails');
    assert.equal(
      fs.readFileSync(path.join(orphanDir, 'SKILL.md'), 'utf8'),
      '不可销毁的用户内容',
    );
  });
});
