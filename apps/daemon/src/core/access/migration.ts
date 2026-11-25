import type Database from 'better-sqlite3';

/** Idempotent schema migration, shared with isolated session-store consumers. */
export function migrateAdminAccess(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_digest TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      credential_digest TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_credential_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      credential_digest TEXT NOT NULL
    );
  `);
}
