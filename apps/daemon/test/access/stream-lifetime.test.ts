import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSessionStore } from '../../src/core/access/sessions.js';
import { wrapSessionStream } from '../../src/core/access/stream-lifetime.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('revocation closes only the matching stream and cancels its producer', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSessionStore(db, { credential: 'one' });
    const one = store.create(); const two = store.create();
    let cancelled = 0;
    function source() {
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('open')); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const a = wrapSessionStream(source(), one, store, () => !!store.verify(one.token));
    const b = wrapSessionStream(source(), two, store, () => !!store.verify(two.token));
    const readerA = a.body!.getReader(); const readerB = b.body!.getReader();
    assert.equal((await readerA.read()).done, false); assert.equal((await readerB.read()).done, false);
    const pendingA = readerA.read();
    store.revoke(one.token);
    assert.equal((await pendingA).done, true);
    await tick(); assert.equal(cancelled, 1);
    assert.ok(store.verify(two.token));
    store.revokeAll();
    assert.equal((await readerB.read()).done, true);
    await tick(); assert.equal(cancelled, 2);
  } finally { db.close(); }
});

test('expired and already revoked sessions close without returning bytes', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSessionStore(db, { credential: 'one' });
    const s = store.create(); store.revoke(s.token);
    const response = wrapSessionStream(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } })), s, store, () => !!store.verify(s.token));
    assert.equal((await response.body!.getReader().read()).done, true);
  } finally { db.close(); }
});

test('stream ends at the session expiry even if no new events arrive', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSessionStore(db, { credential: 'one' });
    const session = store.create();
    let cancelled = false;
    const source = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const response = wrapSessionStream(source, { ...session, expiresAt: Date.now() + 50 }, store, () => true);
    const reader = response.body!.getReader();
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('expiry did not close stream')), 1000)),
    ]);
    assert.equal(result.done, true);
    await tick();
    assert.equal(cancelled, true);
  } finally { db.close(); }
});

test('revocation does not deliver buffered stream events to a later read', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSessionStore(db, { credential: 'one' });
    const session = store.create();
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const source = new Response(new ReadableStream<Uint8Array>({ start(c) { producer = c; } }));
    const wrapped = wrapSessionStream(source, session, store, () => !!store.verify(session.token));
    producer.enqueue(new Uint8Array([1]));
    await tick();
    store.revoke(session.token);
    assert.equal((await wrapped.body!.getReader().read()).done, true);
  } finally { db.close(); }
});

test('normal completion, abort and client cancellation release stream resources once', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSessionStore(db, { credential: 'one' });
    let listeners = 0;
    const tracked = { ...store, subscribeRevocation(callback: Parameters<typeof store.subscribeRevocation>[0]) {
      listeners++;
      const unsubscribe = store.subscribeRevocation(callback);
      let removed = false;
      return () => { if (!removed) { removed = true; listeners--; unsubscribe(); } };
    } };
    const session = store.create();
    const finished = wrapSessionStream(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } })), session, tracked, () => true);
    assert.equal(listeners, 1);
    assert.deepEqual([...new Uint8Array(await finished.arrayBuffer())], [1]);
    assert.equal(listeners, 0);

    let cancelled = 0;
    const source = () => new Response(new ReadableStream({ cancel() { cancelled++; } }));
    const abort = new AbortController();
    const aborted = wrapSessionStream(source(), session, tracked, () => true, abort.signal);
    const reader = aborted.body!.getReader();
    const pending = reader.read();
    abort.abort(); abort.abort();
    assert.equal((await pending).done, true);
    await reader.cancel();
    await tick();
    assert.equal(listeners, 0);
    assert.equal(cancelled, 1);

    const disconnected = wrapSessionStream(source(), session, tracked, () => true);
    const other = disconnected.body!.getReader();
    await other.cancel();
    store.revoke(session.token);
    await other.cancel();
    await tick();
    assert.equal(listeners, 0);
    assert.equal(cancelled, 2);
  } finally { db.close(); }
});

test('completion, cancellation, abort, revocation and expiry clear their timers', async () => {
  const db = new Database(':memory:');
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  try {
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      timers.delete(timer);
      return originalClearTimeout(timer);
    }) as typeof clearTimeout;
    const store = createSessionStore(db, { credential: 'one' });
    const session = store.create();
    function wrap(source: Response, expiresAt = session.expiresAt, signal?: AbortSignal) {
      globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        const timer = originalSetTimeout(...args);
        timers.add(timer);
        return timer;
      }) as typeof setTimeout;
      try { return wrapSessionStream(source, { ...session, expiresAt }, store, () => true, signal); }
      finally { globalThis.setTimeout = originalSetTimeout; }
    }
    const source = () => new Response(new ReadableStream({}));
    const finite = wrap(new Response(new ReadableStream({ start(c) { c.close(); } })));
    await finite.arrayBuffer();
    assert.equal(timers.size, 0);
    const cancelled = wrap(source());
    await cancelled.body!.cancel();
    assert.equal(timers.size, 0);
    const abort = new AbortController();
    wrap(source(), session.expiresAt, abort.signal);
    abort.abort();
    assert.equal(timers.size, 0);
    const expiring = wrap(source(), Date.now() + 20);
    assert.equal((await expiring.body!.getReader().read()).done, true);
    assert.equal(timers.size, 0);
    wrap(source());
    store.revoke(session.token);
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    db.close();
  }
});
