import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../../src/core/access/sessions.js';

const fingerprint = 'credential-one';

test('sessions persist only hashes and expire without sliding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-sessions-'));
  const file = join(dir, 'sessions.sqlite');
  let now = 1000;
  try {
    let db = new Database(file);
    let store = createSessionStore(db, { credential: fingerprint, now: () => now });
    const a = store.create();
    const b = store.create();
    assert.notEqual(a.token, b.token);
    const rows = JSON.stringify(db.prepare('SELECT * FROM admin_sessions').all());
    assert.equal(rows.includes(a.token), false);
    assert.equal(store.verify(a.token)?.expiresAt, a.expiresAt);
    now += 1000;
    db.close();
    db = new Database(file);
    store = createSessionStore(db, { credential: fingerprint, now: () => now });
    assert.equal(store.verify(a.token)?.expiresAt, a.expiresAt);
    store.revoke(a.token);
    assert.equal(store.verify(a.token), null);
    assert.ok(store.verify(b.token));
    now = b.expiresAt;
    assert.equal(store.verify(b.token), null);
    store.pruneExpired();
    assert.equal((db.prepare('SELECT count(*) AS n FROM admin_sessions').get() as { n: number }).n, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changing credentials revokes sessions and revocation is observable', () => {
  const db = new Database(':memory:');
  try {
    const store = createSessionStore(db, { credential: fingerprint });
    const a = store.create();
    const b = store.create();
    const revoked: string[] = [];
    const dispose = store.subscribeRevocation((digest) => revoked.push(digest));
    store.revoke(a.token);
    assert.deepEqual(revoked, [a.digest]);
    store.revokeAll();
    assert.ok(revoked.includes(b.digest));
    dispose();
    const c = store.create();
    const changed = createSessionStore(db, { credential: 'changed' });
    assert.equal(changed.verify(c.token), null);
  } finally { db.close(); }
});

test('creating a session cleans expired records and notifies their streams', () => {
  const db = new Database(':memory:');
  let now = 1000;
  try {
    const store = createSessionStore(db, { credential: fingerprint, now: () => now });
    const old = store.create();
    const revoked: string[] = [];
    store.subscribeRevocation((digest) => revoked.push(digest));
    now = old.expiresAt;
    const fresh = store.create();
    assert.deepEqual(revoked, [old.digest]);
    assert.equal(store.verify(old.token), null);
    assert.ok(store.verify(fresh.token));
    assert.equal((db.prepare('SELECT count(*) AS n FROM admin_sessions').get() as { n: number }).n, 1);
  } finally { db.close(); }
});
