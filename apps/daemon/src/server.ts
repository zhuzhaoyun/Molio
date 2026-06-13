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
import { projectRoutes } from './routes/projects.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { publishRoutes, cleanupAllBridges } from './routes/publish.js';
import { graphRoutes } from './routes/graph.js';

export const runManager = new RunManager();
export const db: Database.Database = openDatabase();

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

// Routes
app.route('/api/agents', agentsRoutes(runManager));
app.route('/api/runs', runsRoutes(db, runManager));
app.route('/api/runs', eventsRoutes(runManager));
app.route('/api/runs', toolResultRoutes(runManager));
app.route('/api/config', configRoutes());
app.route('/api/projects', projectRoutes(db));
app.route('/api/knowledge', knowledgeRoutes(db, runManager));
app.route('/api/publish', publishRoutes());
app.route('/api/graph', graphRoutes(db));

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
process.on('SIGINT', () => {
  cleanupAllBridges();
  runManager.cancelAll();
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupAllBridges();
  runManager.cancelAll();
  closeDatabase();
  process.exit(0);
});
