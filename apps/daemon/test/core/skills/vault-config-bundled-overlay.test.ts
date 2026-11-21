import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { reconcileBundledSync } from '../../../src/core/skill-installer.js';
import { reconcileVault } from '../../../src/core/skills/vault-config.js';
import { createSkill, updateCustomInstructions } from '../../../src/core/skills/store.js';
import { listQuarantineEvents } from '../../../src/core/skills/quarantine.js';
import { USER_CUSTOM_BEGIN, USER_CUSTOM_END } from '../../../src/core/skills/compose.js';

let molioHome: string;
let dbDir: string;
let db: Database.Database;
let sourceDir: string;
let vaultPath: string;
const RAW = '---\nname: wiki-x\n---\n\n上游正文';

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-bundled-overlay-home-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-bundled-overlay-db-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-bundled-overlay-src-'));
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-bundled-overlay-vault-'));
  db = openDatabase(dbDir);
  fs.mkdirSync(path.join(sourceDir, 'wiki-x'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'wiki-x', 'SKILL.md'), RAW, 'utf8');
});

afterEach(() => {
  closeDatabase();
  for (const d of [molioHome, dbDir, sourceDir, vaultPath]) fs.rmSync(d, { recursive: true, force: true });
});

const vaultSkillMd = (slug = 'wiki-x'): string =>
  fs.readFileSync(path.join(vaultPath, '.claude', 'skills', slug, 'SKILL.md'), 'utf8');

function runSync(kv: {
  effective: Set<string>;
  managed?: Set<string>;
  custom?: Map<string, string>;
  withDb?: boolean;
}): void {
  reconcileBundledSync(kv.effective, kv.managed ?? new Set(kv.effective), vaultPath, {
    sourceDir,
    ...(kv.withDb === false ? {} : { db }),
    ...(kv.custom ? { customBySlug: kv.custom } : {}),
    molioHome,
  });
}

describe('reconcileBundledSync × overlay', () => {
  it('lands the sentinel-wrapped overlay in the vault SKILL.md', () => {
    runSync({ effective: new Set(['wiki-x']), custom: new Map([['wiki-x', '输出用简体中文']]) });
    const md = vaultSkillMd();
    assert.ok(md.startsWith(RAW), 'raw upstream bytes stay first, untouched');
    assert.ok(md.includes(`${USER_CUSTOM_BEGIN}\n输出用简体中文\n${USER_CUSTOM_END}`), 'sentinel block appended');
  });

  it('overlay change re-reconciles silently (update, not drift)', () => {
    runSync({ effective: new Set(['wiki-x']), custom: new Map([['wiki-x', '第一版']]) });
    runSync({ effective: new Set(['wiki-x']), custom: new Map([['wiki-x', '第二版']]) });
    assert.ok(vaultSkillMd().includes('第二版'));
    assert.equal(listQuarantineEvents(db, { unackedOnly: true }).length, 0, 'overlay edits via API are updates, never drift');
  });

  it('clearing the overlay converges the vault copy back to raw bytes', () => {
    runSync({ effective: new Set(['wiki-x']), custom: new Map([['wiki-x', '临时']]) });
    runSync({ effective: new Set(['wiki-x']), custom: new Map() });
    assert.equal(vaultSkillMd(), RAW);
  });

  it('step-3 removal: dest == raw source for a non-effective slug is removed (existing behavior)', () => {
    runSync({ effective: new Set(['wiki-x']) }); // sync it
    runSync({ effective: new Set(), managed: new Set(['wiki-x']) }); // now not effective
    assert.equal(fs.existsSync(path.join(vaultPath, '.claude', 'skills', 'wiki-x')), false);
  });

  it('step-3 removal: a dest carrying overlay bytes is NOT silently deleted (row gone ⇒ no proof)', () => {
    runSync({ effective: new Set(['wiki-x']), custom: new Map([['wiki-x', '我的定制']]) });
    // Row retired ⇒ customBySlug no longer knows the slug ⇒ ownership proof fails.
    runSync({ effective: new Set(), managed: new Set(['wiki-x']), custom: new Map() });
    const dest = path.join(vaultPath, '.claude', 'skills', 'wiki-x');
    assert.equal(fs.existsSync(dest), true, 'user-customized copy must not be rm -rf’d without proof');
    assert.ok(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes('我的定制'));
  });

  it('without db the behavior is exactly the legacy one: plain raw mirror, no guard', () => {
    runSync({ effective: new Set(['wiki-x']), custom: new Map([['wiki-x', 'overlay 会被忽略']]), withDb: false });
    assert.equal(vaultSkillMd(), RAW, 'no db ⇒ no compose, raw mirror (old callers unchanged)');
  });
});

describe('reconcileVault wiring', () => {
  it('passes db + customBySlug from the skills table (bundled overlay via API lands in the vault)', () => {
    // Use a REAL shipped slug: reconcileVault resolves the bundled source from
    // the app resources, which the unit tests above inject — this wiring test
    // deliberately goes through the real resolution to prove the full path.
    createSkill(db, { id: 'docling', name: 'docling', description: 'd', enabled: true, builtIn: true, kind: 'bundled' }, '');
    updateCustomInstructions(db, 'docling', '来自 API 的自定义指令');
    reconcileVault(db, { id: 'v1', name: '库一', path: vaultPath, fileCount: 0, createdAt: Date.now() });
    const md = vaultSkillMd('docling');
    assert.ok(md.includes('来自 API 的自定义指令'), 'overlay appended to the real shipped SKILL.md');
    assert.ok(md.includes(USER_CUSTOM_BEGIN));
  });
});
