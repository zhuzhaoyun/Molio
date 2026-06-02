import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { RunManager } from '../core/RunManager.js';
import { createSSEStream } from '../sse.js';

export function eventsRoutes(runManager: RunManager): Hono {
  const app = new Hono();

  // GET /api/runs/:id/events — SSE stream with replay support
  app.get('/:id/events', (c) => {
    const runId = c.req.param('id');

    if (!runManager.hasRun(runId)) {
      return c.json({
        error: { code: 'NOT_FOUND', message: `Run not found: ${runId}` },
      }, 404);
    }

    // Get last event ID for replay: query param `after` or Last-Event-ID header
    const afterParam = c.req.query('after');
    const lastEventIdHeader = c.req.header('Last-Event-ID');
    const afterId = Number(afterParam || lastEventIdHeader || 0);

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return stream(c, async (s) => {
      const { stream: sseStream, cleanup } = createSSEStream(runManager, runId, afterId);

      // Cleanup on client disconnect
      c.req.raw.signal.addEventListener('abort', cleanup);

      // Pipe the SSE stream to the response
      await s.pipe(sseStream);
    });
  });

  return app;
}
