import type Database from 'better-sqlite3';

export function migratePublication(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS publication_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      vault_id TEXT
    );
    INSERT OR IGNORE INTO publication_state (id, enabled, revision, vault_id) VALUES (1, 0, 0, NULL);

    CREATE TABLE IF NOT EXISTS publication_pages (
      revision INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      PRIMARY KEY (revision, page_id)
    );
    CREATE TABLE IF NOT EXISTS publication_page_admin (
      revision INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_markdown TEXT NOT NULL,
      project_markdown TEXT NOT NULL,
      PRIMARY KEY (revision, page_id),
      FOREIGN KEY (revision, page_id) REFERENCES publication_pages(revision, page_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS publication_assets (
      revision INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      PRIMARY KEY (revision, asset_id)
    );
    CREATE TABLE IF NOT EXISTS publication_page_assets (
      revision INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      PRIMARY KEY (revision, page_id, asset_id),
      FOREIGN KEY (revision, page_id) REFERENCES publication_pages(revision, page_id) ON DELETE CASCADE,
      FOREIGN KEY (revision, asset_id) REFERENCES publication_assets(revision, asset_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS publication_asset_admin (
      revision INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      PRIMARY KEY (revision, asset_id),
      FOREIGN KEY (revision, asset_id) REFERENCES publication_assets(revision, asset_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS publication_edges (
      revision INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (revision, source_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS publication_source_ids (
      vault_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY (vault_id, source_path),
      UNIQUE (vault_id, page_id)
    );
    CREATE INDEX IF NOT EXISTS idx_publication_pages_revision ON publication_pages(revision, title);
    CREATE INDEX IF NOT EXISTS idx_publication_page_assets_asset ON publication_page_assets(revision, asset_id);
  `);
}
