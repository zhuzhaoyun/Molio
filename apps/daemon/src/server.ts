import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type Database from 'better-sqlite3';
import { RunManager } from './core/RunManager.js';
import { openDatabase, closeDatabase } from './core/db.js';
import { agentsRoutes } from './routes/agents.js';
import { runsRoutes } from './routes/runs.js';
import { eventsRoutes } from './routes/events.js';
import { toolResultRoutes } from './routes/tool-result.js';
import { configRoutes } from './routes/config.js';
import { conversationRoutes } from './routes/conversations.js';
import { projectRoutes } from './routes/projects.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { publishRoutes, cleanupAllBridges } from './routes/publish.js';
import { proxyRoutes } from './routes/proxy.js';
import { graphRoutes } from './routes/graph.js';
import { weixinRoutes } from './routes/weixin.js';
import { feishuRoutes } from './routes/feishu.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { WeixinService } from './core/weixin/service.js';
import { FeishuService } from './core/feishu/service.js';
import { ConversationService } from './core/conversations/service.js';
import { VaultWatcher } from './core/vault-watcher.js';
import { createPreloadManager } from './core/preload-manager.js';
import { preloadRoutes } from './routes/preload.js';

export const runManager = new RunManager();
export const db: Database.Database = openDatabase();
export const conversationService = new ConversationService(db);
export const weixinService = new WeixinService(runManager, conversationService, db);
export const feishuService = new FeishuService(runManager, conversationService, db);
export const vaultWatcher = new VaultWatcher(db);
export const preloadManager = createPreloadManager();

export const app = new Hono();

// CORS — allow Vite dev server, daemon itself, and Electron dev
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    try {
      const url = new URL(origin);
      if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.protocol === 'http:') {
        return origin;
      }
    } catch { /* ignore */ }
    return undefined;
  },
}));

// Health check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok' as const, version: '0.1.0' });
});

// Graceful shutdown endpoint — called by the desktop shell before quitting
// so we can flush in-flight assistant replies to the database.
app.post('/api/shutdown', async (c) => {
  console.log('Shutdown requested by desktop shell, flushing active runs...');
  cleanupAllBridges();
  weixinService.stop();
  await feishuService.stop();
  void vaultWatcher.stop();
  runManager.cancelAll();
  closeDatabase();
  // Give the HTTP response a chance to be sent before exiting
  setTimeout(() => process.exit(0), 100);
  return c.body(null, 204);
});


// Routes
app.route('/api/agents', agentsRoutes(runManager));
app.route('/api/runs', runsRoutes(db, runManager, conversationService));
app.route('/api/runs', eventsRoutes(runManager));
app.route('/api/runs', toolResultRoutes(runManager));
app.route('/api/config', configRoutes());
app.route('/api/conversations', conversationRoutes(db, runManager, conversationService));
app.route('/api/projects', projectRoutes(db));
app.route('/api/knowledge', knowledgeRoutes(db, runManager, vaultWatcher));
app.route('/api/publish', publishRoutes());
app.route('/api/proxy', proxyRoutes());
app.route('/api/graph', graphRoutes(db));
app.route('/api/weixin', weixinRoutes(weixinService));
app.route('/api/feishu', feishuRoutes(feishuService));
app.route('/api/preload', preloadRoutes(preloadManager));
app.route('/api/maintenance', maintenanceRoutes(db));

void weixinService.start();
void feishuService.start();
void vaultWatcher.start();

// Static file serving (production / desktop mode)
const staticDir = process.env['MOLIO_STATIC_DIR'];

// MIME type mapping
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
  '.xml': 'text/xml',
  '.pdf': 'application/pdf',
};

if (staticDir) {
  // Serve static files with custom middleware
  app.use('/*', async (c, next) => {
    const url = new URL(c.req.url);
    let pathname = decodeURIComponent(url.pathname);

    // Security: prevent directory traversal
    if (pathname.includes('..')) {
      return c.notFound();
    }

    // Default to index.html for root
    if (pathname === '/') {
      pathname = '/index.html';
    }

    const filePath = join(staticDir, pathname);

    // Check if file exists
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath).toLowerCase();
      const mimeType = mimeTypes[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      return c.body(content, 200, { 'Content-Type': mimeType });
    }

    // SPA fallback: serve index.html for non-API, non-asset routes
    if (!pathname.startsWith('/api/') && !extname(pathname)) {
      const indexPath = join(staticDir, 'index.html');
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath);
        return c.body(content, 200, { 'Content-Type': 'text/html' });
      }
    }

    await next();
  });
}

// Graceful shutdown
function gracefulShutdown(): void {
  cleanupAllBridges();
  weixinService.stop();
  void vaultWatcher.stop();
  runManager.cancelAll();
  // Feishu stop() is async (WSClient teardown); chain DB close + exit AFTER
  // it resolves so we don't close the SQLite handle while a WS callback is
  // mid-write. WeixinService.stop() is still sync (polling-based, no async
  // teardown), so it's safe to call before the await.
  void feishuService.stop().finally(() => {
    closeDatabase();
    process.exit(0);
  });
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
