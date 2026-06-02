import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { RunManager } from '../core/RunManager.js';
import { createSSEStream } from '../sse.js';

export function eventsRoutes(runManager: RunManager): Hono {
  const app = new Hono();

  // GET /api/runs/:id/events — SSE stream
  app.get('/:id/events', (c) => {
    const runId = c.req.param('id');

    if (!runManager.hasRun(runId)) {
      return c.json({
        error: { code: 'NOT_FOUND', message: `Run not found: ${runId}` },
      }, 404);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return stream(c, async (s) => {
      const { stream: sseStream, cleanup } = createSSEStream(runManager, runId);

      // Cleanup on client disconnect
      c.req.raw.signal.addEventListener('abort', cleanup);

      // Pipe the SSE stream to the response
      await s.pipe(sseStream);
    });
  });

  return app;
}
