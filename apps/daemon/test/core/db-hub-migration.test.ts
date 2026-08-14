import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../src/core/db.js';

/**
 * hub_skill_installs first shipped (pre-release) with `slug TEXT PRIMARY KEY`;
 * the current schema uses a composite (namespace, slug) PK. openDatabase()
 * rebuilds the table in place. That rebuild must be all-or-nothing: a crash
 * mid-rebuild previously stranded the registry (better-sqlite3 autocommits
 * each exec statement), and a leftover `hub_skill_installs_new` made the next
 * startup throw out of migrate().
 */
describe('db migration: hub_skill_installs slug-PK → (namespace, slug) PK', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-hub-migrate-test-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Seed a DB carrying the OLD slug-only-PK schema plus rows (slug, skill_id, namespace). */
  function seedOldSchema(rows: Array<[string, string, string]>): void {
    const raw = new Database(join(tempDir, 'app.sqlite'));
    raw.exec(`
      CREATE TABLE hub_skill_installs (
        slug         TEXT PRIMARY KEY,
        skill_id     TEXT NOT NULL,
        version      TEXT NOT NULL DEFAULT '',
        namespace    TEXT NOT NULL DEFAULT '',
        installed_at INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `);
    const insert = raw.prepare(
      `INSERT INTO hub_skill_installs (slug, skill_id, version, namespace, installed_at, updated_at)
       VALUES (?, ?, '1.0.0', ?, 1000, 2000)`,
    );
    for (const [slug, skillId, namespace] of rows) insert.run(slug, skillId, namespace);
    raw.close();
  }

  function readRows(): Array<{ slug: string; skill_id: string; namespace: string }> {
    const raw = new Database(join(tempDir, 'app.sqlite'), { readonly: true });
    const rows = raw
      .prepare('SELECT slug, skill_id, namespace FROM hub_skill_installs ORDER BY namespace, slug')
      .all() as Array<{ slug: string; skill_id: string; namespace: string }>;
    raw.close();
    return rows;
  }

  function primaryKeyColumns(): string[] {
    const raw = new Database(join(tempDir, 'app.sqlite'), { readonly: true });
    const cols = raw
      .prepare('PRAGMA table_info(hub_skill_installs)')
      .all() as Array<{ name: string; pk: number }>;
    raw.close();
    return cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  }

  it('rebuilds with composite PK and preserves rows', () => {
    seedOldSchema([
      ['pdf-tools', 'sk-aaa', 'alice'],
      ['weekly-report', 'sk-bbb', 'bob'],
    ]);

    openDatabase(tempDir);
    closeDatabase();

    assert.deepEqual(primaryKeyColumns(), ['namespace', 'slug']);
    assert.deepEqual(readRows(), [
      { slug: 'pdf-tools', skill_id: 'sk-aaa', namespace: 'alice' },
      { slug: 'weekly-report', skill_id: 'sk-bbb', namespace: 'bob' },
    ]);
  });

  it('self-heals when a crashed rebuild left hub_skill_installs_new behind', () => {
    seedOldSchema([['pdf-tools', 'sk-aaa', 'alice']]);
    // Simulate a crash between CREATE _new and DROP old: the leftover table
    // used to make the next startup throw "table ... already exists".
    const raw = new Database(join(tempDir, 'app.sqlite'));
    raw.exec(`
      CREATE TABLE hub_skill_installs_new (
        slug TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        namespace TEXT NOT NULL DEFAULT '',
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, slug)
      );
      INSERT INTO hub_skill_installs_new VALUES ('partial', 'sk-zzz', '1.0.0', 'ghost', 1000, 2000);
    `);
    raw.close();

    assert.doesNotThrow(() => openDatabase(tempDir));
    closeDatabase();

    // The authoritative old table's rows win; the partial _new rows are gone.
    assert.deepEqual(primaryKeyColumns(), ['namespace', 'slug']);
    assert.deepEqual(readRows(), [{ slug: 'pdf-tools', skill_id: 'sk-aaa', namespace: 'alice' }]);
  });

  it('allows same slug in different namespaces after migration', () => {
    seedOldSchema([['pdf-tools', 'sk-aaa', 'alice']]);

    openDatabase(tempDir);
    // The post-migration PK must permit the coexistence the old PK forbade.
    assert.doesNotThrow(() => {
      const db = openDatabase(tempDir);
      db.prepare(
        `INSERT INTO hub_skill_installs (slug, skill_id, version, namespace, installed_at, updated_at)
         VALUES ('pdf-tools', 'sk-ccc', '1.0.0', 'carol', 1000, 2000)`,
      ).run();
    });
    closeDatabase();

    const rows = readRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.namespace), ['alice', 'carol']);
  });
});
