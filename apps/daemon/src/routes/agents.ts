import { Hono } from 'hono';
import type { RunManager } from '../core/RunManager.js';

export function agentsRoutes(runManager: RunManager): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const agents = runManager.detectAgents();
    return c.json({ agents });
  });

  return app;
}
