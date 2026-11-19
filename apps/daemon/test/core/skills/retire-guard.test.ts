import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../../src/core/db.js';
import { createSkill, updateCustomInstructions } from '../../../src/core/skills/store.js';
import { quarantineRetiredWithOverlay } from '../../../src/core/skills/retire-guard.js';
import { listQuarantineEvents } from '../../../src/core/skills/quarantine.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

/**
 * Retirement guard: a bundled skill being retired while carrying a user
 * overlay must hand its vault copies to the quarantine BEFORE the startup
 * seed deletes the row (after that the overlay — and proof of what the vault
 * copies contain — is gone). No orphan dirs, no silent destruction.
 */

let molioHome: string;
let dbDir: string;
let vaultRoot: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-retire-home-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-retire-db-'));
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-retire-vaults-'));
  db = openDatabase(dbDir);
  opts = { molioHome };
});

afterEach(() => {
  closeDatabase();
  for (const d of [molioHome, dbDir, vaultRoot]) fs.rmSync(d, { recursive: true, force: true });
});

function makeVaultWithCopy(slug: string, content: string): string {
  const vaultPath = path.join(vaultRoot, `v-${slug}`);
  fs.mkdirSync(vaultPath, { recursive: true });
  createVault(db, `库-${slug}`, vaultPath);
  const copy = path.join(vaultPath, '.claude', 'skills', slug);
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'SKILL.md'), content, 'utf8');
  return copy;
}

describe('skills/retire-guard quarantineRetiredWithOverlay', () => {
  it('retired slug WITH overlay: vault copy quarantined + event, dir removed, no orphan', () => {
    const slug = RETIRED_SAMPLE;
    createSkill(db, { id: slug, name: slug, description: '', enabled: true, builtIn: true, kind: 'bundled' }, '');
    updateCustomInstructions(db, slug, '我的定制');
    const copy = makeVaultWithCopy(slug, '---\nname: x\n---\n\n带定制的副本');

    quarantineRetiredWithOverlay(db, opts);

    const evs = listQuarantineEvents(db, { unackedOnly: true });
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.source, 'retired');
    assert.equal(evs[0]!.skillId, slug);
    const qPath = listQuarantineEvents(db)[0]!.quarantinedPath;
    assert.equal(fs.readFileSync(path.join(qPath, 'SKILL.md'), 'utf8'), '带定制的副本');
    assert.equal(fs.existsSync(copy), false, 'no orphan dir left behind');
  });

  it('retired slug WITHOUT overlay: untouched (normal step-3 machinery owns it)', () => {
    const slug = RETIRED_SAMPLE;
    createSkill(db, { id: slug, name: slug, description: '', enabled: true, builtIn: true, kind: 'bundled' }, '');
    const copy = makeVaultWithCopy(slug, '裸内容');
    quarantineRetiredWithOverlay(db, opts);
    assert.equal(fs.existsSync(copy), true, 'no overlay ⇒ guard does nothing');
    assert.equal(listQuarantineEvents(db).length, 0);
  });

  it('idempotent: after the row is deleted a second run records nothing', () => {
    const slug = RETIRED_SAMPLE;
    createSkill(db, { id: slug, name: slug, description: '', enabled: true, builtIn: true, kind: 'bundled' }, '');
    updateCustomInstructions(db, slug, 'x');
    makeVaultWithCopy(slug, '内容');
    quarantineRetiredWithOverlay(db, opts);
    db.prepare('DELETE FROM skills WHERE id = ?').run(slug); // what the seed does next
    quarantineRetiredWithOverlay(db, opts); // second startup
    assert.equal(listQuarantineEvents(db).length, 1, 'no duplicate events');
  });
});

/** A slug from the real RETIRED_BUNDLED_SKILLS list ('remotion'). */
const RETIRED_SAMPLE = 'remotion';
