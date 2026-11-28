import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { openDatabase, closeDatabase, listExternalRoots } from './core/db.js';
import { AuthClient } from './core/auth/auth-client.js';
import { disposeVaultWorkers } from './core/vault-worker.js';
import { reconcileAllVaultsAsync } from './core/skills/vault-config.js';
import { createKnowledgeServices } from './knowledge-services.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { graphRoutes, makeGraphWarmer } from './routes/graph.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { marketRoutes } from './routes/market.js';
import { proxyRoutes } from './routes/proxy.js';
import { publishRoutes, cleanupAllBridges } from './routes/publish.js';
import { createStaticFileMiddleware } from './static-files.js';

// Only the DSH plugin owns this service and its random loopback port.
if (!process.connected) throw new Error('The Molio knowledge service requires a plugin IPC parent');
const staticDir = process.env.MOLIO_STATIC_DIR;
if (!staticDir) throw new Error('Missing bundled Molio interface');

const db = openDatabase();
const { vaultWatcher, vaultIndexSweeper, graphCache, treeCache } = createKnowledgeServices(db);
const cached = (id: string) => vaultWatcher.isReady(id);
const graphWarmer = makeGraphWarmer(graphCache, cached);
let graphWarmTimer: ReturnType<typeof setTimeout> | null = null;
const auth = new AuthClient();
const app = new Hono();
// Reject cross-origin writes and Host headers outside the bound loopback origin.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname !== '127.0.0.1') return c.text('Forbidden', 403);
  const origin = c.req.header('origin');
  if (origin && origin !== url.origin && !['GET', 'HEAD'].includes(c.req.method)) return c.text('Forbidden', 403);
  await next();
});
app.get('/api/health', c => c.json({ status: 'ok', version: '0.1.0', activeRuns: 0, uptime: Math.floor(process.uptime()), memory: process.memoryUsage() }));
app.route('/api/knowledge', knowledgeRoutes(db, vaultWatcher, treeCache, cached, (vault) => {
  if (graphWarmTimer) clearTimeout(graphWarmTimer);
  graphWarmTimer = setTimeout(() => {
    graphWarmTimer = null;
    if (!closing) {
      void graphWarmer(vault, listExternalRoots(db, vault.id).map((r) => ({ label: r.label, target: r.target })));
    }
  }, 1500);
  graphWarmTimer.unref?.();
}));
app.route('/api/graph', graphRoutes(db, graphCache, cached));
app.route('/api/market', marketRoutes(db, auth));
app.route('/api/auth', authRoutes(auth));
app.route('/api/config', configRoutes());
app.route('/api/proxy', proxyRoutes());
app.route('/api/publish', publishRoutes());
app.use('/*', createStaticFileMiddleware(staticDir));

let closing = false;
let startupChoresTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTask: Promise<void> | null = null;
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, ({ port }) => {
  process.send?.({ type: 'molio-ready', port });
  void auth.restoreSession();
  // Defer multi-vault watcher startup and skill directory fan-out slightly so the
  // initial /vaults + /tree requests get uncontested CPU and disk I/O.
  startupChoresTimer = setTimeout(() => {
    startupChoresTimer = null;
    if (closing) return;
    vaultWatcher.start();
    reconcileTask = reconcileAllVaultsAsync(db).catch(() => {});
  }, 800);
  startupChoresTimer.unref?.();
});
async function shutdown() {
  if (closing) return;
  closing = true;
  if (startupChoresTimer) {
    clearTimeout(startupChoresTimer);
    startupChoresTimer = null;
  }
  if (graphWarmTimer) {
    clearTimeout(graphWarmTimer);
    graphWarmTimer = null;
  }
  server.close();
  cleanupAllBridges();
  vaultIndexSweeper.stop();
  await vaultWatcher.stop();
  if (reconcileTask) {
    await reconcileTask;
    reconcileTask = null;
  }
  disposeVaultWorkers();
  closeDatabase();
  process.exit(0);
}
process.once('disconnect', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
