import { Hono } from 'hono';
import type { WeixinService } from '../core/weixin/service.js';
import type { WeixinConfig } from '../core/config.js';
import { channelRoutes } from './channel.js';

/**
 * Weixin channel HTTP routes. Adds /login (weixin's QR login flow) on
 * top of the 5 standard channel routes.
 */
export function weixinRoutes(service: WeixinService): Hono {
  const app = channelRoutes<WeixinConfig>(service);
  app.post('/login', async (c) => c.json(await service.beginLogin()));
  return app;
}
