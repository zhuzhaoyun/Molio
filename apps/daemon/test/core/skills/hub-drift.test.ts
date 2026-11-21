import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import { installHubSkill, _setHubFetchForTests } from '../../../src/core/skills/hub.js';
import { skillContentDir, type SkillPathsOpts } from '../../../src/core/skills/paths.js';
import { listQuarantineEvents } from '../../../src/core/skills/quarantine.js';
import { updateCustomInstructions } from '../../../src/core/skills/store.js';

/**
 * Hub-refresh safety net (trigger B): a library source that drifted from what
 * we installed is user content — an update click must back it up before
 * overwriting, and must never touch the overlay column.
 */

function zipOf(files: Record<string, string>): Uint8Array {
  const entries = Object.entries(files).map(([k, v]) => [k, strToU8(v)] as const);
  return zipSync(Object.fromEntries(entries));
}

function pkg(body: string, version: string): Uint8Array {
  return zipOf({
    'SKILL.md': `---\nname: Demo\ndescription: d\nversion: ${version}\n---\n\n${body}`,
    '_meta.json': JSON.stringify({ slug: 'demo', version }),
  });
}

function serveZip(zip: Uint8Array): typeof fetch {
  return (async (input: unknown) => {
    if (String(input).includes('/api/v1/download')) {
      return new Response(zip, { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-drift-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-drift-claude-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-drift-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  _setHubFetchForTests();
  closeDatabase();
  for (const d of [molioHome, claudeHome, dbDir]) fs.rmSync(d, { recursive: true, force: true });
});

const events = (): { source: string }[] => listQuarantineEvents(db, { unackedOnly: true });

describe('skills/hub refresh drift protection', () => {
  it('clean refresh (content matches install record): silent, no event', async () => {
    _setHubFetchForTests(serveZip(pkg('v1 正文', '1.0.0')));
    const first = await installHubSkill(db, { slug: 'demo' }, opts);
    const again = await installHubSkill(db, { slug: 'demo' }, opts); // same bytes
    assert.equal(again.updated, true);
    assert.equal(events().length, 0, 'clean refresh must not cry wolf');
  });

  it('hand-edited library source: old content quarantined + hub-update event, overlay untouched', async () => {
    _setHubFetchForTests(serveZip(pkg('v1 正文', '1.0.0')));
    const first = await installHubSkill(db, { slug: 'demo' }, opts);
    updateCustomInstructions(db, first.skill.id, '我的自定义指令');

    // User edits the library base behind Molio's back.
    const mdPath = path.join(skillContentDir(first.skill.id, opts), 'SKILL.md');
    fs.writeFileSync(mdPath, fs.readFileSync(mdPath, 'utf8') + '\n用户补的一行', 'utf8');

    _setHubFetchForTests(serveZip(pkg('v2 正文', '1.1.0')));
    const second = await installHubSkill(db, { slug: 'demo' }, opts);

    assert.equal(second.updated, true);
    const evs = events();
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.source, 'hub-update');
    const qPath = listQuarantineEvents(db)[0]!.quarantinedPath;
    assert.ok(fs.readFileSync(path.join(qPath, 'SKILL.md'), 'utf8').includes('用户补的一行'), 'old bytes preserved');
    assert.ok(fs.readFileSync(mdPath, 'utf8').includes('v2 正文'), 'new package in place');
    // The overlay column is orthogonal to base refresh — must survive.
    const overlayRow = db.prepare('SELECT custom_instructions FROM skills WHERE id = ?').get(first.skill.id) as { custom_instructions: string | null };
    assert.equal(overlayRow.custom_instructions, '我的自定义指令');
  });

  it('legacy install row with empty hash: first refresh also backs up before overwriting', async () => {
    _setHubFetchForTests(serveZip(pkg('旧版正文', '1.0.0')));
    const first = await installHubSkill(db, { slug: 'demo' }, opts);
    // Simulate a pre-feature install record: no recorded hash.
    db.prepare('UPDATE hub_skill_installs SET installed_content_hash = NULL').run();

    _setHubFetchForTests(serveZip(pkg('新版正文', '1.1.0')));
    await installHubSkill(db, { slug: 'demo' }, opts);
    const evs = events();
    assert.equal(evs.length, 1, 'legacy rows quarantine on first refresh (2026-11-19 ruling)');
    assert.equal(evs[0]!.source, 'hub-update');
    const qPath = listQuarantineEvents(db)[0]!.quarantinedPath;
    assert.ok(fs.readFileSync(path.join(qPath, 'SKILL.md'), 'utf8').includes('旧版正文'));
  });

  it('a fresh install records its content hash (baseline for the next refresh)', async () => {
    _setHubFetchForTests(serveZip(pkg('v1 正文', '1.0.0')));
    await installHubSkill(db, { slug: 'demo' }, opts);
    const row = db.prepare('SELECT installed_content_hash FROM hub_skill_installs').get() as { installed_content_hash: string | null };
    assert.ok(typeof row.installed_content_hash === 'string' && row.installed_content_hash.length > 0, 'hash recorded at install time');
  });
});
