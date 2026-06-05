import { Hono } from 'hono';
import type { ToolResultRequest } from '@molio/contracts';
import type { RunManager } from '../core/RunManager.js';

export function toolResultRoutes(runManager: RunManager): Hono {
  const app = new Hono();

  // POST /api/runs/:id/tool-result
  app.post('/:id/tool-result', async (c) => {
    const runId = c.req.param('id');

    if (!runManager.hasRun(runId)) {
      return c.json({
        error: { code: 'NOT_FOUND', message: `Run not found: ${runId}` },
      }, 404);
    }

    const body = await c.req.json<ToolResultRequest>();

    if (!body.toolUseId) {
      return c.json({
        error: { code: 'BAD_REQUEST', message: 'toolUseId is required' },
      }, 400);
    }

    try {
      runManager.submitToolResult(runId, body.toolUseId, body.content);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({
        error: { code: 'CONFLICT', message: (err as Error).message },
      }, 409);
    }
  });

  return app;
}
