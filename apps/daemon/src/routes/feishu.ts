import type { Hono } from 'hono';
import type { FeishuService } from '../core/feishu/service.js';
import type { FeishuConfig } from '../core/config.js';
import { channelRoutes } from './channel.js';

/**
 * Feishu channel HTTP routes. No /login endpoint (feishu doesn't have a
 * QR login flow — saving app_id/app_secret via PUT /config triggers
 * start()).
 */
export function feishuRoutes(service: FeishuService): Hono {
  return channelRoutes<FeishuConfig>(service);
}
