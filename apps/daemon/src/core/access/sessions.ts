import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { migrateAdminAccess } from './migration.js';

const LIFETIME_MS = 12 * 60 * 60 * 1000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const digestToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AdminSession {
  digest: string;
  expiresAt: number;
}
export interface CreatedSession extends AdminSession { token: string }

export function createSessionStore(db: Database.Database, options: { credential: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const credential = createHash('sha256').update(options.credential).digest('hex');
  const listeners = new Set<(digest: string) => void>();

  migrateAdminAccess(db);
  db.transaction(() => {
    const state = db.prepare('SELECT credential_digest FROM admin_credential_state WHERE id = 1').get() as { credential_digest: string } | undefined;
    if (state && state.credential_digest !== credential) db.prepare('DELETE FROM admin_sessions').run();
    db.prepare('INSERT INTO admin_credential_state (id, credential_digest) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET credential_digest = excluded.credential_digest').run(credential);
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now());
  })();

  function notify(digest: string) {
    for (const listener of listeners) {
      try { listener(digest); } catch { /* one listener cannot block revocation */ }
    }
  }
  function verify(token: string): AdminSession | null {
    if (!TOKEN_FORMAT.test(token)) return null;
    const digest = digestToken(token);
    const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_digest = ? AND credential_digest = ? AND expires_at > ?').get(digest, credential, now()) as { expires_at: number } | undefined;
    return row ? { digest, expiresAt: row.expires_at } : null;
  }
  function pruneExpired(): void {
    const rows = db.transaction(() => {
      const timestamp = now();
      const found = db.prepare('SELECT token_digest FROM admin_sessions WHERE expires_at <= ?').all(timestamp) as Array<{ token_digest: string }>;
      db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(timestamp);
      return found;
    })();
    for (const row of rows) notify(row.token_digest);
  }

  return {
    create(): CreatedSession {
      pruneExpired();
      const token = randomBytes(32).toString('base64url');
      const digest = digestToken(token);
      const createdAt = now();
      const expiresAt = createdAt + LIFETIME_MS;
      db.prepare('INSERT INTO admin_sessions (token_digest, created_at, expires_at, credential_digest) VALUES (?, ?, ?, ?)').run(digest, createdAt, expiresAt, credential);
      return { token, digest, expiresAt };
    },
    verify,
    revoke(token: string): void {
      if (!TOKEN_FORMAT.test(token)) return;
      const digest = digestToken(token);
      if (db.prepare('DELETE FROM admin_sessions WHERE token_digest = ?').run(digest).changes) notify(digest);
    },
    revokeAll(): void {
      const rows = db.transaction(() => {
        const found = db.prepare('SELECT token_digest FROM admin_sessions').all() as Array<{ token_digest: string }>;
        db.prepare('DELETE FROM admin_sessions').run();
        return found;
      })();
      for (const row of rows) notify(row.token_digest);
    },
    pruneExpired,
    subscribeRevocation(callback: (digest: string) => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
