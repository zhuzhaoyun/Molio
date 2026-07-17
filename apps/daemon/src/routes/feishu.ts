import { Hono } from 'hono';
import type { FeishuService } from '../core/feishu/service.js';
import type { FeishuConfig } from '../core/config.js';

/**
 * Feishu channel HTTP routes. No /login endpoint (feishu doesn't have a QR
 * login flow — saving app_id/app_secret via PUT /config triggers start()).
 */
export function feishuRoutes(service: FeishuService): Hono {
  const app = new Hono();

  app.get('/status', (c) => c.json(service.getStatus()));

  app.post('/start', async (c) => {
    return c.json(await service.start());
  });

  app.post('/stop', (c) => {
    return c.json(service.stop());
  });

  app.post('/disconnect', (c) => {
    return c.json(service.disconnect());
  });

  app.put('/config', async (c) => {
    const body = await c.req.json<FeishuConfig>();
    return c.json(await service.updateConfig(body));
  });

  return app;
}
