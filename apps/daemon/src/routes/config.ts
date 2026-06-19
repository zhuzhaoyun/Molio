import { Hono } from 'hono';
import { loadConfig, saveConfig, getAgentConfig, setAgentConfig, mergeConfig } from '../core/config.js';
import type { AppConfig, AgentConfig } from '../core/config.js';

export function configRoutes(): Hono {
  const app = new Hono();

  // GET /api/config
  app.get('/', (c) => {
    return c.json(loadConfig());
  });

  // PUT /api/config — merge with existing config to prevent partial
  // updates from wiping agent configs (API keys, env vars, etc.).
  app.put('/', async (c) => {
    const body = await c.req.json<Partial<AppConfig>>();
    saveConfig(mergeConfig(body));
    return c.json({ ok: true });
  });

  // GET /api/config/agents/:agentId
  app.get('/agents/:agentId', (c) => {
    return c.json(getAgentConfig(c.req.param('agentId')));
  });

  // PUT /api/config/agents/:agentId
  app.put('/agents/:agentId', async (c) => {
    const body = await c.req.json<AgentConfig>();
    setAgentConfig(c.req.param('agentId'), body);
    return c.json({ ok: true });
  });

  return app;
}
