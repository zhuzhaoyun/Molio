import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import {
  quarantineDir,
  quarantineRoot,
  recordQuarantineEvent,
  listQuarantineEvents,
  ackQuarantineEvent,
  cleanupExpiredQuarantine,
  type QuarantineSource,
  type SkillQuarantineEvent,
} from '../../../src/core/skills/quarantine.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-quarantine-home-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-quarantine-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome };
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function makeSourceDir(name: string): string {
  const dir = path.join(molioHome, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n\n正文', 'utf8');
  fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), 'print("hi")\r\n中文', 'utf8');
  return dir;
}

describe('skills/quarantine quarantineDir', () => {
  it('copies the whole tree byte-for-byte into <molioHome>/skill-quarantine/<label>-<ts>-<rand>/', () => {
    const src = makeSourceDir('src-a');
    const dest = quarantineDir(src, 'bundled-wiki-query', opts);
    assert.ok(dest, 'must return the quarantine path');
    assert.ok(path.dirname(dest) === quarantineRoot(opts), 'must live directly under skill-quarantine/');
    assert.ok(path.basename(dest).startsWith('bundled-wiki-query-'), `dir name carries the label: ${path.basename(dest)}`);
    // Byte-for-byte content check.
    assert.equal(
      fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8'),
    );
    assert.equal(
      fs.readFileSync(path.join(dest, 'scripts', 'run.py'), 'utf8'),
      fs.readFileSync(path.join(src, 'scripts', 'run.py'), 'utf8'),
    );
  });

  it('returns null (never throws) when the source dir is missing', () => {
    const dest = quarantineDir(path.join(molioHome, 'no-such-dir'), 'bundled-x', opts);
    assert.equal(dest, null);
  });

  it('returns null (never throws) for an unsafe label', () => {
    const src = makeSourceDir('src-b');
    assert.equal(quarantineDir(src, '../escape', opts), null);
    assert.equal(quarantineDir(src, 'a/b', opts), null);
  });
});

describe('skills/quarantine events', () => {
  it('record → list (createdAt DESC) → ack → drops out of unacked list', () => {
    const first = recordQuarantineEvent(db, {
      source: 'vault-drift',
      skillId: 'wiki-query',
      mirrorName: 'wiki-query',
      description: '检测到本地修改，已隔离后重建',
      quarantinedPath: '/tmp/q1',
    });
    recordQuarantineEvent(db, {
      source: 'vault-cold-start',
      mirrorName: 'tutor',
      description: '升级后首次同步差异备份',
      quarantinedPath: '/tmp/q2',
    });
    assert.ok(typeof first === 'number' && first > 0);

    const all = listQuarantineEvents(db);
    assert.equal(all.length, 2);
    // DESC by created_at; tie-break must keep both — assert set of sources then order.
    assert.deepEqual(
      all.map((e: SkillQuarantineEvent) => e.source).sort(),
      ['vault-cold-start', 'vault-drift'],
    );

    const unacked = listQuarantineEvents(db, { unackedOnly: true });
    assert.equal(unacked.length, 2);

    assert.equal(ackQuarantineEvent(db, first), true);
    const afterAck = listQuarantineEvents(db, { unackedOnly: true });
    assert.equal(afterAck.length, 1);
    assert.equal(afterAck[0]!.source satisfies QuarantineSource, 'vault-cold-start');
    // Full list still contains the acked one, flagged.
    const fullAfter = listQuarantineEvents(db);
    assert.equal(fullAfter.find((e: SkillQuarantineEvent) => e.id === first)?.acked, true);
  });

  it('ack of an unknown id returns false', () => {
    assert.equal(ackQuarantineEvent(db, 99999), false);
  });
});

describe('skills/quarantine cleanupExpiredQuarantine', () => {
  it('deems dirs older than 30 days gone, keeps fresh ones', () => {
    const fresh = quarantineDir(makeSourceDir('src-fresh'), 'bundled-a', opts);
    const stale = quarantineDir(makeSourceDir('src-stale'), 'bundled-b', opts);
    assert.ok(fresh && stale);
    // Backdate the stale one by 40 days.
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    fs.utimesSync(stale, old, old);

    cleanupExpiredQuarantine(opts);

    assert.equal(fs.existsSync(fresh), true, 'fresh quarantine dir survives');
    assert.equal(fs.existsSync(stale), false, '40-day-old dir is removed');
  });
});
