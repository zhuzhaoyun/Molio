import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { openDatabase, closeDatabase } from './core/db.js';
import { AuthClient } from './core/auth/auth-client.js';
import { disposeVaultWorkers } from './core/vault-worker.js';
import { reconcileAllVaults } from './core/skills/vault-config.js';
import { createKnowledgeServices } from './knowledge-services.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { graphRoutes } from './routes/graph.js';
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
reconcileAllVaults(db);
const { vaultWatcher, vaultIndexSweeper, graphCache, treeCache } = createKnowledgeServices(db);
const cached = (id: string) => vaultWatcher.isReady(id);
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
app.route('/api/knowledge', knowledgeRoutes(db, vaultWatcher, treeCache, cached));
app.route('/api/graph', graphRoutes(db, graphCache, cached));
app.route('/api/market', marketRoutes(db, auth));
app.route('/api/auth', authRoutes(auth));
app.route('/api/config', configRoutes());
app.route('/api/proxy', proxyRoutes());
app.route('/api/publish', publishRoutes());
app.use('/*', createStaticFileMiddleware(staticDir));

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, ({ port }) => {
  process.send?.({ type: 'molio-ready', port });
  void auth.restoreSession();
  vaultWatcher.start();
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  cleanupAllBridges();
  vaultIndexSweeper.stop();
  await vaultWatcher.stop();
  disposeVaultWorkers();
  closeDatabase();
  process.exit(0);
}
process.once('disconnect', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
