import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { VaultWatcher } from '../../src/core/vault-watcher.js';
import { createSessionStore } from '../../src/core/access/sessions.js';
import { createAccessGuard, csrfToken, ADMIN_COOKIE } from '../../src/core/access/guard.js';
import { eventsRoutes } from '../../src/routes/events.js';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { preloadRoutes } from '../../src/routes/preload.js';
import { agentsRoutes } from '../../src/routes/agents.js';
import type { PreloadManager } from '../../src/core/preload-manager.js';
import type { AccessConfig } from '../../src/core/access/config.js';
import type { InstallOptions } from '../../src/core/runtimes/install.js';

const origin = 'https://example.test';
const turn = () => new Promise((resolve) => setTimeout(resolve, 10));
async function eof(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const timeout = new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('stream did not close')), 2000); t.unref(); });
  return Promise.race([reader.read(), timeout]);
}

test('revocation closes and cleans each real management stream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-streams-'));
  const db = openDatabase(dir);
  const store = createSessionStore(db, { credential: 'test' });
  const config: AccessConfig = { mode: 'server', host: '127.0.0.1', publicOrigin: origin, username: 'admin', passwordHash: `scrypt$32768$8$1$${'ab'.repeat(16)}$${'cd'.repeat(64)}` };
  let runSubscriptions = 0; let preloadSubscriptions = 0; let installAborted = false;
  const rm = {
    hasRun: () => true, getBufferedEvents: () => [], isTerminal: () => false, getLastEventId: () => 0,
    onEvent: () => { runSubscriptions++; return () => { runSubscriptions--; }; },
    invalidateAgentCache: () => {}, detectAgentsAsync: async () => [],
  } as unknown as RunManager;
  const watcher = new VaultWatcher(db); const vault = createVault(db, 'test', dir);
  const preload = {
    getStatus: () => ({ status: 'missing' }),
    getStatuses: () => ({ docling: { status: 'missing' } }),
    onProgress: () => { preloadSubscriptions++; return () => { preloadSubscriptions--; }; },
    startPreload: async () => {},
  } as unknown as PreloadManager;
  const fakeDependencies = {
    getAgentDef: () => ({ install: {} }),
    installAgent: async (opts: InstallOptions) => { await new Promise<void>((resolve) => opts.signal!.addEventListener('abort', () => { installAborted = true; resolve(); }, { once: true })); },
  };
  const app = new Hono(); app.use('*', createAccessGuard(config, store));
  app.route('/api/runs', eventsRoutes(rm));
  app.route('/api/knowledge', knowledgeRoutes(db, rm, watcher));
  app.route('/api/preload', preloadRoutes(preload));
  app.route('/api/agents', agentsRoutes(rm, fakeDependencies as never));
  try {
    for (const [method, path, body] of [
      ['GET', '/api/runs/example/events', undefined],
      ['GET', `/api/knowledge/vaults/${vault.id}/events`, undefined],
      ['POST', '/api/preload/start', JSON.stringify({ skills: ['docling'] })],
      ['POST', '/api/agents/test-agent/install', undefined],
    ] as const) {
      const session = store.create();
      const response = await app.request(path, { method, headers: { cookie: `${ADMIN_COOKIE}=${session.token}`, origin, 'x-molio-csrf': csrfToken(session.token), 'content-type': 'application/json' }, body });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      const reader = response.body!.getReader();
      const pending = eof(reader);
      store.revoke(session.token);
      assert.equal((await pending).done, true, path);
      await turn();
      if (path.includes('/runs/')) assert.equal(runSubscriptions, 0);
      if (path.includes('/knowledge/')) assert.equal(watcher.listenerCount('tree-changed'), 0);
      if (path.includes('/preload/')) assert.equal(preloadSubscriptions, 0);
      if (path.includes('/agents/')) assert.equal(installAborted, true);
    }
  } finally { store.revokeAll(); closeDatabase(); rmSync(dir, { recursive: true, force: true }); }
});

test('knowledge heartbeat is an observable SSE message and releases its timer',async(t)=>{
  t.mock.timers.enable({apis:['setInterval']});
  const clear=t.mock.method(globalThis,'clearInterval');
  const dir=mkdtempSync(join(tmpdir(),'molio-heartbeat-'));const db=openDatabase(dir);const watcher=new VaultWatcher(db);const vault=createVault(db,'heartbeat',dir);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{const app=new Hono();app.route('/api/knowledge',knowledgeRoutes(db,{} as RunManager,watcher));const response=await app.request(`/api/knowledge/vaults/${vault.id}/events`);reader=response.body!.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'data: ping\n\n');const pending=reader.read();t.mock.timers.tick(15000);const result=await pending;assert.equal(new TextDecoder().decode(result.value),'data: ping\n\n');await reader.cancel();await turn();assert.equal(watcher.listenerCount('tree-changed'),0);assert.equal(clear.mock.callCount(),1);}finally{await reader?.cancel().catch(()=>{});t.mock.timers.reset();closeDatabase();rmSync(dir,{recursive:true,force:true});}
});
