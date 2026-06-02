import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { RunManager } from './core/RunManager.js';
import { agentsRoutes } from './routes/agents.js';
import { runsRoutes } from './routes/runs.js';
import { eventsRoutes } from './routes/events.js';
import { toolResultRoutes } from './routes/tool-result.js';
import { configRoutes } from './routes/config.js';

export const runManager = new RunManager();

export const app = new Hono();

// CORS — allow Vite dev server and daemon itself
app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3100'],
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
