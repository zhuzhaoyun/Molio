import { Hono } from 'hono';
import type { WeixinService } from '../core/weixin/service.js';
import type { WeixinConfig } from '../core/config.js';

export function weixinRoutes(service: WeixinService): Hono {
  const app = new Hono();

  app.get('/status', (c) => c.json(service.getStatus()));

  app.post('/login', async (c) => {
    return c.json(await service.beginLogin());
  });

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
    const body = await c.req.json<WeixinConfig>();
    return c.json(await service.updateConfig(body));
  });

  return app;
}
