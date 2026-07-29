import { Hono } from 'hono';

/**
 * Shared channel-status shape returned by every channel service's
 * getStatus/start/stop/disconnect/updateConfig. We type as `unknown` here
 * because each channel (feishu/weixin/wecom) has its own concrete status
 * type; the factory only forwards the JSON to the client.
 */
type ChannelStatus = unknown;

/**
 * Minimum service surface a channel needs to be mounted under
 * /api/<channel>/. The /login endpoint is channel-specific (only weixin
 * has one) so it's NOT in this interface — callers add it themselves
 * after invoking the factory.
 */
interface ChannelServiceLike<TConfig> {
  getStatus(): ChannelStatus;
  /**
   * `force` marks an explicit user action (the POST /start button) as opposed
   * to boot auto-start. Channels may use it to re-enable a disabled channel /
   * force a reconnect. Optional — services that don't need it (e.g. weixin,
   * whose start takes no args) simply ignore the extra argument.
   */
  start(force?: boolean): ChannelStatus | Promise<ChannelStatus>;
  stop(): ChannelStatus | Promise<ChannelStatus>;
  disconnect(): ChannelStatus | Promise<ChannelStatus>;
  updateConfig(next: TConfig): ChannelStatus | Promise<ChannelStatus>;
}

/**
 * Factory for the 5 standard channel routes: GET /status, POST /start,
 * POST /stop, POST /disconnect, PUT /config. Extracted so feishu/weixin/
 * wecom don't repeat the same boilerplate — channels with extra routes
 * (e.g. weixin's /login) compose this factory with their own additions.
 */
export function channelRoutes<TConfig>(
  service: ChannelServiceLike<TConfig>,
): Hono {
  const app = new Hono();

  app.get('/status', (c) => c.json(service.getStatus()));

  // POST /start is the explicit user action — force=true so it re-enables a
  // disconnected channel and reconnects even when already connected.
  app.post('/start', async (c) => c.json(await service.start(true)));

  app.post('/stop', async (c) => c.json(await service.stop()));

  app.post('/disconnect', async (c) => c.json(await service.disconnect()));

  app.put('/config', async (c) => {
    const body = await c.req.json<TConfig>();
    return c.json(await service.updateConfig(body));
  });

  return app;
}
