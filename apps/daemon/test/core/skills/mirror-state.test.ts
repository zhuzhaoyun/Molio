import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import {
  getMirrorHash,
  setMirrorHash,
  guardedMirror,
  __setMirrorStateDepsForTest,
} from '../../../src/core/skills/mirror-state.js';
import { listQuarantineEvents } from '../../../src/core/skills/quarantine.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;
let srcDir: string;
let destDir: string;
const vaultA = '/vaults/alpha';
const vaultB = '/vaults/beta';

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-mirror-home-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-mirror-db-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-mirror-src-'));
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-mirror-dest-'));
  fs.rmSync(destDir, { recursive: true, force: true }); // start without dest
  db = openDatabase(dbDir);
  opts = { molioHome };
});

afterEach(() => {
  __setMirrorStateDepsForTest(null); // restore real deps
  closeDatabase();
  for (const d of [molioHome, dbDir, srcDir, destDir]) fs.rmSync(d, { recursive: true, force: true });
});

function writeSrc(content: string): void {
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'SKILL.md'), content, 'utf8');
}

function writeDest(content: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), content, 'utf8');
}

function events(): { source: string; description: string }[] {
  return listQuarantineEvents(db, { unackedOnly: true });
}

describe('skills/mirror-state guardedMirror', () => {
  it('fresh mirror (dest missing): no event, baseline recorded', () => {
    writeSrc('v1');
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 'wiki-query', label: 'bundled-wiki-query', skillId: 'wiki-query' }, opts);
    assert.equal(events().length, 0);
    assert.ok(getMirrorHash(db, vaultA, 'wiki-query'));
    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), 'v1');
  });

  it('source update (dest==baseline): silent rebuild, no event, baseline advances', () => {
    writeSrc('v1');
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
    writeSrc('v2'); // upstream changed
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
    assert.equal(events().length, 0, 'source update must not false-positive');
    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), 'v2');
  });

  it('user drift (dest!=baseline): quarantined + vault-drift event, then rebuilt', () => {
    writeSrc('v1');
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s', skillId: 'docling' }, opts);
    writeDest('v1-user-patched'); // user edited the mirror behind Molio's back
    writeSrc('v2'); // AND upstream moved — drift must win over update
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s', skillId: 'docling' }, opts);
    const evs = events();
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.source, 'vault-drift');
    // The user's patched bytes survive in the quarantine area.
    const qPath = listQuarantineEvents(db)[0]!.quarantinedPath;
    assert.equal(fs.readFileSync(path.join(qPath, 'SKILL.md'), 'utf8'), 'v1-user-patched');
    // And the mirror is rebuilt from source.
    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), 'v2');
  });

  it('cold start (dest exists, no baseline, src!=dest): quarantined + vault-cold-start event', () => {
    writeSrc('official-v2');
    writeDest('unknown-state'); // pre-existing mirror, no baseline row
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
    const evs = events();
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.source, 'vault-cold-start');
    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), 'official-v2');
  });

  it('cold start with dest already matching the composed source: no event, baseline adopted', () => {
    writeSrc('v2');
    writeDest('v2');
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
    assert.equal(events().length, 0);
    assert.ok(getMirrorHash(db, vaultA, 's'));
  });

  it('mirror failure leaves the baseline untouched and rethrows', () => {
    writeSrc('v1');
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
    const baselineBefore = getMirrorHash(db, vaultA, 's');
    writeSrc('v2');
    writeDest('v2-patched');
    let threw: unknown = null;
    __setMirrorStateDepsForTest({
      mirrorDirIfChanged: () => {
        throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' });
      },
    });
    try {
      guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'must rethrow so the existing reconcile degradation handles it');
    assert.equal(getMirrorHash(db, vaultA, 's'), baselineBefore, 'baseline must not advance on failure');
  });

  it('baselines are per-vault: drift in vault A does not touch vault B', () => {
    writeSrc('v1');
    const destB = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-mirror-destB-'));
    fs.rmSync(destB, { recursive: true, force: true });
    try {
      // Vault A: drift; vault B: clean first sync from the same source.
      writeDest('v1-patched');
      guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
      guardedMirror(db, { srcDir, destDir: destB, vaultPath: vaultB, mirrorDir: 's', label: 'bundled-s' }, opts);
      assert.equal(events().length, 1, 'only vault A records an event');
      assert.equal(listQuarantineEvents(db)[0]!.source, 'vault-cold-start'); // no baseline in A either
      assert.ok(getMirrorHash(db, vaultB, 's'));
    } finally {
      fs.rmSync(destB, { recursive: true, force: true });
    }
  });

  it('quarantine failure still records an event (description notes it) and never throws', () => {
    writeSrc('v2');
    writeDest('user-bytes');
    __setMirrorStateDepsForTest({
      quarantineDir: () => null, // the copy fails
    });
    guardedMirror(db, { srcDir, destDir, vaultPath: vaultA, mirrorDir: 's', label: 'bundled-s' }, opts);
    const evs = events();
    assert.equal(evs.length, 1);
    assert.ok(evs[0]!.description.includes('隔离备份失败'), `description must note the failure: ${evs[0]!.description}`);
    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), 'v2', 'mirror proceeds');
  });
});
