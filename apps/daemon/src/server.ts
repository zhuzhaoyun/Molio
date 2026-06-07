import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
app.route('/api/runs', runsRoutes(runManager));
app.route('/api/runs', eventsRoutes(runManager));
app.route('/api/runs', toolResultRoutes(runManager));
app.route('/api/config', configRoutes());
app.route('/api/projects', projectRoutes(db));
app.route('/api/knowledge', knowledgeRoutes(db, runManager));

// Static file serving (production / desktop mode)
const staticDir = process.env['KGE_STATIC_DIR'];
if (staticDir) {
  // Serve static assets (js, css, images, etc.)
  app.use('/*', serveStatic({ root: staticDir }));

  // SPA fallback: serve index.html for non-API, non-asset routes
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const indexPath = join(staticDir, 'index.html');
    if (existsSync(indexPath)) {
      return c.html(readFileSync(indexPath, 'utf-8'));
    }
    return c.notFound();
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  runManager.cancelAll();
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  runManager.cancelAll();
  closeDatabase();
  process.exit(0);
});
