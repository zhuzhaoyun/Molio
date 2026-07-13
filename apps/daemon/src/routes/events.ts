import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { RunManager } from '../core/RunManager.js';
import { createSSEStream } from '../sse.js';
import { dbgLog } from '../core/debug-log.js';

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

    // Get last event id for replay: query param `after` or Last-Event-ID header
    const afterParam = c.req.query('after');
    const lastEventIdHeader = c.req.header('Last-Event-ID');
    const afterId = Number(afterParam || lastEventIdHeader || 0);

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    // SSE is a long-lived connection. Disable Node's per-socket timeout for this
    // response so the server never aborts a healthy idle stream. @hono/node-server
    // exposes the Node IncomingMessage via c.env.incoming. (Node 24 defaults:
    // server.timeout=0 already, but requestTimeout=300s / headersTimeout=60s could
    // bite SSE under future configs — set explicitly as a safety net. The real
    // ~11.5min abort was traced to the client/Chromium side, not here, but this
    // removes the server as a suspect and is cheap.)
    const incoming = (c.env as any)?.incoming as import('node:http').IncomingMessage | undefined;
    const sock = incoming?.socket;
    // setTimeout(0) disables Node's per-socket idle timeout so the server never
    // aborts a healthy idle SSE stream. TCP keepalive left at OS defaults — too
    // slow to matter here; the client-side watchdog is the real recovery mechanism.
    sock?.setTimeout?.(0);

    return stream(c, async (s) => {
      const { stream: sseStream, cleanup } = createSSEStream(runManager, runId, afterId);

      // On client disconnect (or any abort of the request signal), clean up the
      // SSE subscription so emit events don't fan out to a dead listener. Log the
      // abort + socket state to help locate which layer kills the long connection.
      c.req.raw.signal.addEventListener('abort', () => {
        dbgLog(
          `abort runId=${runId} socket.destroyed=${sock?.destroyed} ` +
          `remote=${sock?.remoteAddress}:${sock?.remotePort}`,
        );
        cleanup();
      });

      // Pipe the SSE stream to the response
      await s.pipe(sseStream);
    });
  });

  return app;
}
