import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createPublicationStore } from '../../src/core/publication/store.js';
import { migratePublication } from '../../src/core/publication/migration.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readPublicationSource } from '../../src/core/publication/project.js';

test('identical image files referenced by one page create one publishable asset association', () => {
  const vaultPath = makeVault([['wiki/a.md', '# A\n![one](one.png) ![copy](copy.png)']]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path.join(vaultPath, 'wiki/one.png'), png); writeFileSync(path.join(vaultPath, 'wiki/copy.png'), png);
  const db = createDb();
  try {
    const store = createPublicationStore(db, { limits: { maxAssetsPerPage: 1 } });
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    assert.equal(preview.pages[0]!.assets.length, 1);
    assert.doesNotThrow(() => store.commitPreview('session', preview.id, preview.expectedRevision));
  } finally { db.close(); }
});

test('heading and index/log Wiki links never expose unpublished targets', () => {
  const vaultPath = makeVault([['wiki/a.md', '# A\n[[Private/Secret#Plan]] [[Private/index]] [[Private/log|Private alias]] [[B#Section]]'], ['wiki/b.md', '# B']]);
  const db = createDb();
  try {
    const store = createPublicationStore(db);
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md'] });
    const markdown = preview.pages.find(page => page.sourcePath === 'wiki/a.md')!.markdown;
    assert.doesNotMatch(markdown, /Private|Secret|Plan|\[\[/);
    assert.match(markdown, /molio-page:/, 'a heading link to a published page still resolves');
  } finally { db.close(); }
});

test('oversized Markdown is rejected before reading its contents', () => {
  const vaultPath = makeVault([['wiki/oversized.md', '# Too large for the configured limit']]);
  const original = fs.readFileSync;
  const reads: string[] = [];
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads.push(String(args[0])); return Reflect.apply(original, fs, args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => readPublicationSource(vaultPath, 'wiki/oversized.md', 'page', () => 'asset', {
      maxMarkdownBytes: 12, maxPages: 10, maxGraphEdges: 10, maxAssetsPerPage: 10, maxAssetBytes: 100, maxRevisionBytes: 100,
    }), /exceeds 12 bytes/);
    assert.equal(reads.length, 0, 'must reject the file before allocating its content');
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test('aggregate preview budget stops loading later selected pages', () => {
  const vaultPath = makeVault([['wiki/a.md', '# A: aaaa'], ['wiki/b.md', '# B: bbbb'], ['wiki/c.md', '# C: cccc']]);
  const db = createDb(); const original = fs.readFileSync; const reads: string[] = [];
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads.push(String(args[0])); return Reflect.apply(original, fs, args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    const store = createPublicationStore(db, { limits: { maxRevisionBytes: 12 } });
    assert.throws(() => store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md', 'wiki/c.md'] }), /exceeds 12 bytes/);
    assert.equal(reads.some(file => file.endsWith('c.md')), false, 'stop before loading subsequent selected content');
    assert.equal(store.getPublicSite().revision, 0);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); db.close(); }
});

test('shared image bytes are charged and hydrated only once per revision', () => {
  const sourceA = '# A\n![image](one.png)'; const sourceB = '# B\n![image](two.png)';
  const vaultPath = makeVault([['wiki/a.md', sourceA], ['wiki/b.md', sourceB]]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path.join(vaultPath, 'wiki/one.png'), png); writeFileSync(path.join(vaultPath, 'wiki/two.png'), png);
  const db = createDb(); let blobRows = 0;
  const observed = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(inner, method) {
        const value = Reflect.get(inner, method, inner);
        if (method !== 'iterate') return typeof value === 'function' ? value.bind(inner) : value;
        return (...args: unknown[]) => (function* () {
          for (const row of Reflect.apply(value, inner, args) as Iterable<Record<string, unknown>>) {
            if (Buffer.isBuffer(row.bytes)) blobRows++;
            yield row;
          }
        })();
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Database.Database;
  try {
    const limit = Buffer.byteLength(sourceA + sourceB) + png.length;
    const store = createPublicationStore(observed, { limits: { maxRevisionBytes: limit } });
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md'] });
    assert.equal(preview.totalBytes, limit, 'identical image bytes at different source paths share the budget');
    store.commitPreview('session', preview.id, preview.expectedRevision);
    blobRows = 0;
    // Retain B without reading its changed/deleted source; replace A and keep the shared image.
    rmSync(path.join(vaultPath, 'wiki/b.md')); writeFileSync(path.join(vaultPath, 'wiki/a.md'), '# A');
    const replacement = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    assert.equal(blobRows, 1, 'the same stored image must not be allocated once per referring page');
    assert.equal(replacement.totalBytes, Buffer.byteLength('# A' + sourceB) + png.length);
  } finally { db.close(); }
});

const dirs: string[] = [];
function makeVault(files: Array<[string, string]>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'molio-publication-test-'));
  dirs.push(root);
  for (const [relative, content] of files) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}
function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migratePublication(db);
  return db;
}
function observePublicationSelectTransactions(db: Database.Database, observations: boolean[], onStateRead?: () => void): Database.Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/^\s*SELECT\b/i.test(sql) || !/publication_(?:state|pages|edges|assets|page_assets)\b/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, method) {
            const value = Reflect.get(inner, method, inner) as unknown;
            if (method === 'iterate') return (...args: unknown[]) => {
              const iterator = (value as (...values: unknown[]) => IterableIterator<unknown>).apply(inner, args);
              return (function* observeRows() {
                for (const row of iterator) {
                  observations.push(target.inTransaction);
                  yield row;
                }
              })();
            };
            if (method !== 'get' && method !== 'all') return value;
            return (...args: unknown[]) => {
              observations.push(target.inTransaction);
              const result = (value as (...values: unknown[]) => unknown).apply(inner, args);
              if (/FROM\s+publication_state\b/i.test(sql)) onStateRead?.();
              return result;
            };
          },
        });
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database.Database;
}
function observeInternalPageQueries(db: Database.Database, statementCount: { value: number }): Database.Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        if (/^\s*SELECT\b/i.test(sql)
          && /\bpublication_(?:pages|page_admin|page_assets|assets|asset_admin)\b/i.test(sql)) statementCount.value += 1;
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database.Database;
}
function seedPublishedPages(db: Database.Database, pageCount: number): void {
  const insertPage = db.prepare('INSERT INTO publication_pages (revision, page_id, title, markdown) VALUES (1, ?, ?, ?)');
  const insertAdmin = db.prepare('INSERT INTO publication_page_admin (revision, page_id, source_path, source_markdown, project_markdown) VALUES (1, ?, ?, ?, ?)');
  const insertSource = db.prepare('INSERT INTO publication_source_ids (vault_id, source_path, page_id) VALUES (?, ?, ?)');
  const insertAsset = db.prepare('INSERT INTO publication_assets (revision, asset_id, content_type, body) VALUES (1, ?, ?, ?)');
  const insertAssetAdmin = db.prepare('INSERT INTO publication_asset_admin (revision, asset_id, source_path) VALUES (1, ?, ?)');
  const insertPageAsset = db.prepare('INSERT INTO publication_page_assets (revision, page_id, asset_id) VALUES (1, ?, ?)');
  db.transaction(() => {
    db.prepare('UPDATE publication_state SET enabled = 0, revision = 1, vault_id = ? WHERE id = 1').run('vault-a');
    for (let index = 0; index < pageCount; index += 1) {
      const suffix = String(index).padStart(4, '0');
      const pageId = `page-${suffix}`;
      const sourcePath = `wiki/existing-${suffix}.md`;
      const assetId = `asset-${suffix}`;
      insertPage.run(pageId, `Existing ${index}`, `# Existing ${index}`);
      insertAdmin.run(pageId, sourcePath, `# Existing ${index}`, `# Existing ${index}`);
      insertSource.run('vault-a', sourcePath, pageId);
      insertAsset.run(assetId, 'image/png', Buffer.from([index % 256]));
      insertAssetAdmin.run(assetId, `wiki/image-${suffix}.png`);
      insertPageAsset.run(pageId, assetId);
    }
  })();
}
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

test('internal publication page reads use a bounded number of SQL statements as snapshots grow', () => {
  const measure = (pageCount: number) => {
    const baseDb = createDb();
    const statementCount = { value: 0 };
    const db = observeInternalPageQueries(baseDb, statementCount);
    try {
      const store = createPublicationStore(db);
      seedPublishedPages(baseDb, pageCount);
      const statusBefore = store.getAdminStatus('vault-a');
      assert.equal(statusBefore.pages.length, pageCount, 'admin status includes the seeded published page list');
      assert.deepEqual(statusBefore.pages[0], {
        id: 'page-0000', title: 'Existing 0', sourcePath: 'wiki/existing-0000.md', published: true,
      });

      statementCount.value = 0;
      const revision = store.setSiteEnabled(1, false);
      assert.equal(revision.pageCount, pageCount);
      const internalPageStatementCount = statementCount.value;
      const statusAfter = store.getAdminStatus('vault-a');
      assert.deepEqual(statusAfter, statusBefore, 'the internal read optimization does not alter status fields');
      return internalPageStatementCount;
    } finally { baseDb.close(); }
  };

  const for100Pages = measure(100);
  const for1000Pages = measure(1000);
  assert.equal(for100Pages, for1000Pages, 'the number of prepared page/asset SELECTs must not grow with page count');
  assert.ok(for1000Pages <= 2, `expected at most two page/asset SELECT statements, received ${for1000Pages}`);
});

test('a new publication store is closed and exposes no source vault details', () => {
  const db = createDb();
  try {
    const store = createPublicationStore(db);
    assert.deepEqual(store.getPublicSite(), { enabled: false, revision: 0, pages: [] });
    assert.equal(store.getPublicGraph(0), null);
    assert.equal(store.getPublicPage('missing', 0), null);
    assert.equal(JSON.stringify(store.getPublicSite()).includes('vaultId'), false);
  } finally { db.close(); }
});

test('public site, page, graph, and asset reads use one SQLite read transaction each', () => {
  const baseDb = createDb();
  const observations: boolean[] = [];
  const db = observePublicationSelectTransactions(baseDb, observations);
  const vaultPath = makeVault([['wiki/a.md', '# Public A\n\n![pixel](pixel.png)\n']]);
  writeFileSync(path.join(vaultPath, 'wiki/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64'));
  try {
    const store = createPublicationStore(db);
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    store.commitPreview('session', preview.id, preview.expectedRevision);
    store.setSiteEnabled(1, true);
    observations.length = 0;

    const site = store.getPublicSite();
    const page = store.getPublicPage(site.pages[0]!.id, site.revision);
    const graph = store.getPublicGraph(site.revision);
    const asset = page?.assetIds[0] ? store.getPublicAsset(page.assetIds[0], site.revision) : null;

    assert.ok(page);
    assert.ok(graph);
    assert.ok(asset);
    assert.ok(observations.length >= 8, 'site and content reads execute their state and DTO queries');
    assert.ok(observations.every(Boolean), `every public SELECT must run inside its read transaction: ${observations}`);
  } finally { baseDb.close(); }
});

test('an in-flight public read keeps one WAL snapshot across a concurrent site close', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'molio-publication-read-race-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'publication.sqlite');
  const readerDb = new Database(dbPath);
  readerDb.pragma('journal_mode = WAL');
  const writerDb = new Database(dbPath);
  const observations: boolean[] = [];
  let closeAfterStateRead: (() => void) | undefined;
  const reader = observePublicationSelectTransactions(readerDb, observations, () => {
    const close = closeAfterStateRead;
    closeAfterStateRead = undefined;
    close?.();
  });
  const vaultPath = makeVault([['wiki/a.md', '# Snapshot A\n']]);
  try {
    const store = createPublicationStore(reader);
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    store.commitPreview('session', preview.id, preview.expectedRevision);
    store.setSiteEnabled(1, true);
    const site = store.getPublicSite();
    const pageId = site.pages[0]!.id;
    observations.length = 0;

    closeAfterStateRead = () => { writerDb.prepare('UPDATE publication_state SET enabled = 0 WHERE id = 1').run(); };
    const inFlight = store.getPublicPage(pageId, site.revision);
    assert.match(inFlight?.markdown ?? '', /Snapshot A/);
    assert.equal((writerDb.prepare('SELECT enabled FROM publication_state WHERE id = 1').get() as { enabled: number }).enabled, 0);
    assert.ok(observations.length >= 2);
    assert.ok(observations.every(Boolean), `all in-flight SELECTs share the reader transaction: ${observations}`);

    const afterClose = store.getPublicPage(pageId, site.revision);
    assert.equal(afterClose, null, 'a read started after the close commit is unavailable');
  } finally { writerDb.close(); readerDb.close(); }
});

test('active publication survives database reopen while in-memory previews expire with the process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'molio-publication-reopen-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'publication.sqlite');
  const vaultPath = makeVault([['wiki/a.md', '# Persisted A\n']]);
  const firstDb = new Database(dbPath);
  migratePublication(firstDb);
  const firstStore = createPublicationStore(firstDb);
  const initial = firstStore.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
  firstStore.commitPreview('session', initial.id, initial.expectedRevision);
  firstStore.setSiteEnabled(1, true);
  const pending = firstStore.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
  firstDb.close();

  const secondDb = new Database(dbPath);
  try {
    const secondStore = createPublicationStore(secondDb);
    const site = secondStore.getPublicSite();
    assert.equal(site.enabled, true);
    assert.equal(site.revision, 1);
    assert.equal(site.pages[0]?.title, 'Persisted A');
    assert.throws(() => secondStore.commitPreview('session', pending.id, pending.expectedRevision), /unavailable|preview/i);
  } finally { secondDb.close(); }
});

test('publication projects only selected Wiki pages and links whose targets are public', () => {
  const db = createDb();
  const vaultPath = makeVault([
    ['wiki/a.md', '---\ntitle: Public A\nsecret: private frontmatter\n---\n# Public A\n\n[[B]] and [[Private/Secret]].\n'],
    ['wiki/b.md', '# Public B\n'],
    ['wiki/Private/Secret.md', '# Private Secret Marker\n'],
    ['notes/private.md', '# Outside Wiki Marker\n'],
  ]);
  try {
    const store = createPublicationStore(db);
    const preview = store.createPreview('admin-session-a', {
      vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md'],
    });
    store.commitPreview('admin-session-a', preview.id, preview.expectedRevision);
    store.setSiteEnabled(preview.expectedRevision + 1, true);

    const site = store.getPublicSite();
    assert.deepEqual(site.pages.map((page) => page.title).sort(), ['Public A', 'Public B']);
    const graph = store.getPublicGraph(site.revision);
    assert.ok(graph);
    assert.deepEqual(graph.nodes.map((node) => node.title).sort(), ['Public A', 'Public B']);
    assert.equal(graph.edges.length, 1);
    assert.deepEqual(graph.edges, [{ source: site.pages.find((page) => page.title === 'Public A')!.id, target: site.pages.find((page) => page.title === 'Public B')!.id }]);

    const a = store.getPublicPage(site.pages.find((page) => page.title === 'Public A')!.id, site.revision)!;
    const serialized = JSON.stringify({ site, graph, a });
    for (const privateMarker of ['Private Secret Marker', 'private frontmatter', 'wiki/Private/Secret.md', 'notes/private.md', 'vault-a', 'deadLinks']) {
      assert.equal(serialized.includes(privateMarker), false, `public projection leaked ${privateMarker}`);
    }
    assert.equal(a.markdown.includes('[[Private/Secret]]'), false, 'unpublished wikilink target is not sent as a public link');
  } finally { db.close(); }
});

test('updating one page keeps other published pages and does not expose edits before commit', () => {
  const db = createDb();
  const vaultPath = makeVault([['wiki/a.md', '# A old\n'], ['wiki/b.md', '# B stays\n']]);
  try {
    const store = createPublicationStore(db);
    const first = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md'] });
    store.commitPreview('session', first.id, first.expectedRevision);
    store.setSiteEnabled(first.expectedRevision + 1, true);
    const oldSite = store.getPublicSite();
    const oldA = oldSite.pages.find((page) => page.title === 'A old')!;
    const b = oldSite.pages.find((page) => page.title === 'B stays')!;

    writeFileSync(path.join(vaultPath, 'wiki/a.md'), '# A new\n');
    const second = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    assert.equal(store.getPublicPage(oldA.id, oldSite.revision)?.markdown.includes('A old'), true);
    assert.equal(second.pages.find((page) => page.title === 'A new')?.id, oldA.id, 'page ID remains stable for a source file');
    store.commitPreview('session', second.id, second.expectedRevision);

    const newSite = store.getPublicSite();
    assert.deepEqual(newSite.pages.map((page) => page.title).sort(), ['A new', 'B stays']);
    assert.equal(newSite.pages.find((page) => page.title === 'B stays')?.id, b.id);
    assert.equal(store.getPublicPage(oldA.id, oldSite.revision), null, 'old revision content is unavailable to new reads');
    assert.match(store.getPublicPage(oldA.id, newSite.revision)!.markdown, /A new/);
  } finally { db.close(); }
});

test('preview candidate is immutable, session-bound, expires, and rejects a stale revision', () => {
  let now = 1_800_000_000_000;
  const db = createDb();
  const vaultPath = makeVault([['wiki/a.md', '# Preview bytes\n']]);
  try {
    const store = createPublicationStore(db, { now: () => now });
    const preview = store.createPreview('session-a', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    writeFileSync(path.join(vaultPath, 'wiki/a.md'), '# Changed after preview\n');
    assert.throws(() => store.commitPreview('session-b', preview.id, preview.expectedRevision), /session/i);
    assert.throws(() => store.commitPreview('session-a', preview.id, preview.expectedRevision + 1), /revision/i);
    store.commitPreview('session-a', preview.id, preview.expectedRevision);
    store.setSiteEnabled(preview.expectedRevision + 1, true);
    const page = store.getPublicSite().pages[0]!;
    assert.match(store.getPublicPage(page.id, store.getPublicSite().revision)!.markdown, /Preview bytes/);
    assert.doesNotMatch(store.getPublicPage(page.id, store.getPublicSite().revision)!.markdown, /Changed after preview/);

    const next = store.createPreview('session-a', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    now += 10 * 60 * 1000 + 1;
    assert.throws(() => store.commitPreview('session-a', next.id, next.expectedRevision), /expired/i);
  } finally { db.close(); }
});

test('failed snapshot transaction keeps the prior revision and site state', () => {
  const db = createDb();
  const vaultPath = makeVault([['wiki/a.md', '# A old\n']]);
  try {
    const store = createPublicationStore(db);
    const first = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    store.commitPreview('session', first.id, first.expectedRevision);
    store.setSiteEnabled(first.expectedRevision + 1, true);
    const before = store.getPublicSite();
    writeFileSync(path.join(vaultPath, 'wiki/a.md'), '# A rejected\n');
    const second = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    db.exec(`CREATE TRIGGER fail_publication_insert BEFORE INSERT ON publication_pages
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;`);
    assert.throws(() => store.commitPreview('session', second.id, second.expectedRevision), /injected publication failure/);
    assert.deepEqual(store.getPublicSite(), before);
    assert.match(store.getPublicPage(before.pages[0]!.id, before.revision)!.markdown, /A old/);
  } finally { db.close(); }
});

test('shared approved images are stored once and remain available while a public page references them', () => {
  const db = createDb();
  const vaultPath = makeVault([
    ['wiki/a.md', '# A\n\n![shared](shared.png)\n'],
    ['wiki/b.md', '# B\n\n![shared](shared.png)\n'],
  ]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path.join(vaultPath, 'wiki/shared.png'), png);
  try {
    const store = createPublicationStore(db);
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md'] });
    const [aPreview, bPreview] = preview.pages;
    assert.ok(aPreview?.assets[0], 'preview identifies approved image dependency');
    assert.equal(aPreview?.assets[0]?.id, bPreview?.assets[0]?.id, 'shared source image has one public asset ID');
    store.commitPreview('session', preview.id, preview.expectedRevision);
    store.setSiteEnabled(preview.expectedRevision + 1, true);
    const site = store.getPublicSite();
    const a = site.pages.find((page) => page.title === 'A')!;
    const b = site.pages.find((page) => page.title === 'B')!;
    const aAsset = store.getPublicPage(a.id, site.revision)!.assetIds[0]!;
    const bAsset = store.getPublicPage(b.id, site.revision)!.assetIds[0]!;
    assert.equal(aAsset, bAsset);
    assert.deepEqual(Buffer.from(store.getPublicAsset(aAsset, site.revision)!.bytes), png);

    const next = store.withdrawPages(site.revision, [a.id]);
    assert.equal(next.pageCount, 1);
    const remaining = store.getPublicSite();
    assert.deepEqual(remaining.pages.map((page) => page.title), ['B']);
    assert.ok(store.getPublicAsset(bAsset, remaining.revision), 'shared asset remains while B references it');
  } finally { db.close(); }
});

test('remote, unsupported, and out-of-vault image links are removed from the public projection', () => {
  const db = createDb();
  const vaultPath = makeVault([['wiki/a.md', '# A\n\n![remote](https://example.test/secret.png)\n![traversal](../../secret.png)\n![svg](bad.svg)\n![missing](missing.png)\n']]);
  writeFileSync(path.join(vaultPath, 'wiki/bad.svg'), '<svg></svg>');
  try {
    const store = createPublicationStore(db);
    const preview = store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] });
    const body = preview.pages[0]!.markdown;
    assert.doesNotMatch(body, /https:\/\/example\.test|\.\.\/\.\.\/secret|bad\.svg/);
    assert.ok(preview.warnings.length >= 4, 'preview explains each omitted image');
    assert.match(body, /\[\[molio-image-unavailable\]\]/, 'image projection marker survives Wiki link projection');
    store.commitPreview('session', preview.id, preview.expectedRevision);
    store.setSiteEnabled(preview.expectedRevision + 1, true);
    const site = store.getPublicSite();
    const page = store.getPublicPage(site.pages[0]!.id, site.revision)!;
    assert.doesNotMatch(page.markdown, /https:\/\/example\.test|\.\.\/\.\.\/secret|bad\.svg/);
    assert.deepEqual(page.assetIds, []);
    assert.match(page.markdown, /\[\[molio-image-unavailable\]\]/, 'public snapshot retains the display marker for visitor rendering');
  } finally { db.close(); }
});

test('a Wiki symlink pointing outside the vault cannot be published', () => {
  const db = createDb();
  const vaultPath = makeVault([]);
  const outside = path.join(vaultPath, '..', 'private-publication-marker.md');
  writeFileSync(outside, '# Private symlink target\n');
  mkdirSync(path.join(vaultPath, 'wiki'), { recursive: true });
  symlinkSync(outside, path.join(vaultPath, 'wiki', 'leak.md'));
  try {
    const store = createPublicationStore(db);
    assert.throws(() => store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/leak.md'] }), /escape/i);
  } finally { db.close(); rmSync(outside, { force: true }); }
});

test('page and batch byte limits fail preview without truncating content', () => {
  const db = createDb();
  const vaultPath = makeVault([['wiki/a.md', '# A\nThis content is over the configured limit.\n']]);
  try {
    const store = createPublicationStore(db, { limits: { maxMarkdownBytes: 12 } });
    assert.throws(() => store.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] }), /exceeds 12 bytes/);
    assert.equal(store.getPublicSite().revision, 0);
  } finally { db.close(); }
});

test('page count, graph edge, asset size, and aggregate revision limits reject the entire preview', () => {
  const db = createDb();
  const vaultPath = makeVault([
    ['wiki/a.md', '# A\n[[B]]\n'],
    ['wiki/b.md', '# B\n'],
  ]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path.join(vaultPath, 'wiki/a.png'), png);
  writeFileSync(path.join(vaultPath, 'wiki/a.md'), '# A\n[[B]]\n![image](a.png)\n');
  try {
    const onePage = createPublicationStore(db, { limits: { maxPages: 1 } });
    assert.throws(() => onePage.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md'] }), /1 pages/);
    const tooFewEdges = createPublicationStore(db, { limits: { maxGraphEdges: 0 } });
    assert.throws(() => tooFewEdges.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md', 'wiki/b.md'] }), /0 graph edges/);
    const tooSmallAsset = createPublicationStore(db, { limits: { maxAssetBytes: 16 } });
    assert.throws(() => tooSmallAsset.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] }), /exceeds 16 bytes/);
    const smallBatch = createPublicationStore(db, { limits: { maxRevisionBytes: 10 } });
    assert.throws(() => smallBatch.createPreview('session', { vaultId: 'vault-a', vaultPath, selectedPaths: ['wiki/a.md'] }), /exceeds 10 bytes/);
    assert.equal(createPublicationStore(db).getPublicSite().revision, 0, 'failed previews never partially publish');
  } finally { db.close(); }
});
